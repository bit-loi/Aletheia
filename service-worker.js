/**
 * service-worker.js: Background orchestrator for Aletheia.
 *
 * Listens for messages from content scripts, runs the pipeline
 * (claim extraction → evidence retrieval → verdict generation),
 * and streams results back to the content script per claim.
 *
 * Uses ES module imports (manifest declares "type": "module").
 */

import { extractClaims, retrieveEvidence, generateVerdict } from './modules/pipeline.js';
import { getCachedVerdict, cacheVerdict } from './modules/cache.js';

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Route by message type; all handlers are async
  if (msg.type === 'CHECK_ARTICLE') {
    handleArticleCheck(sender.tab?.id, msg.text, msg.title, msg.url);
    sendResponse({ ack: true });
  } else if (msg.type === 'START_YOUTUBE') {
    handleYouTubeStart(sender.tab?.id);
    sendResponse({ ack: true });
  } else if (msg.type === 'STOP_YOUTUBE') {
    handleYouTubeStop();
    sendResponse({ ack: true });
  } else if (msg.type === 'PROCESS_TRANSCRIPT_CHUNK') {
    handleTranscriptChunk(sender.tab?.id, msg.text);
    sendResponse({ ack: true });
  }

  // Return true to keep the message channel open (allows async sendResponse,
  // though we use tab messaging for results instead).
  return true;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Send a message to a specific tab's content script.
 */
function sendToTab(tabId, message) {
  if (!tabId) {
    console.warn('[Aletheia SW] No tabId, cannot send message:', message);
    return;
  }
  chrome.tabs.sendMessage(tabId, message).catch((err) => {
    // Tab might have been closed or navigated away
    console.warn('[Aletheia SW] Failed to send to tab:', err.message);
  });
}

// ─── Article Mode Handler ─────────────────────────────────────────────────────

async function handleArticleCheck(tabId, text, title, url) {
  try {
    // Step 1: Extract claims
    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: 'Extracting factual claims…',
      phase: 'extracting',
    });

    let claims;
    try {
      claims = await extractClaims(text);
    } catch (err) {
      sendToTab(tabId, {
        type: 'PIPELINE_ERROR',
        error: `Claim extraction failed: ${err.message}`,
      });
      return;
    }

    if (!claims || claims.length === 0) {
      sendToTab(tabId, {
        type: 'PIPELINE_ERROR',
        error: 'No verifiable claims found in this article.',
      });
      return;
    }

    sendToTab(tabId, {
      type: 'CLAIMS_FOUND',
      count: claims.length,
    });

    // Step 2 & 3: For each claim, retrieve evidence + generate verdict
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];

      sendToTab(tabId, {
        type: 'STATUS_UPDATE',
        status: `Checking claim ${i + 1} of ${claims.length}…`,
        phase: 'checking',
        current: i + 1,
        total: claims.length,
      });

      // Check cache first
      try {
        const cached = await getCachedVerdict(claim);
        if (cached) {
          sendToTab(tabId, {
            type: 'CLAIM_RESULT',
            claim,
            ...cached,
            fromCache: true,
          });
          continue;
        }
      } catch (_) {
        // Cache miss, continue to live check
      }

      // Retrieve evidence
      let evidence = [];
      try {
        evidence = await retrieveEvidence(claim);
      } catch (err) {
        console.warn(`[Aletheia SW] Evidence retrieval failed for claim "${claim.slice(0, 50)}…":`, err);
        // Continue with empty evidence; verdict will likely be "Unverified"
      }

      // Generate verdict
      try {
        const result = await generateVerdict(claim, evidence);

        // Cache the result
        try {
          await cacheVerdict(claim, result);
        } catch (_) {
          // Caching failure is non-critical
        }

        sendToTab(tabId, {
          type: 'CLAIM_RESULT',
          claim,
          ...result,
          fromCache: false,
        });
      } catch (err) {
        console.warn(`[Aletheia SW] Verdict generation failed for claim "${claim.slice(0, 50)}…":`, err);
        sendToTab(tabId, {
          type: 'CLAIM_RESULT',
          claim,
          verdict: 'Unverified',
          explanation: `Could not generate a verdict: ${err.message}`,
          confidence: 'Low',
          key_sources: [],
          fromCache: false,
        });
      }
    }

    // All done
    sendToTab(tabId, { type: 'PIPELINE_COMPLETE' });
  } catch (err) {
    sendToTab(tabId, {
      type: 'PIPELINE_ERROR',
      error: `Pipeline failed: ${err.message}`,
    });
  }
}

// ─── YouTube Mode Handlers (Phase 5, stubs for now) ─────────────────────────

let offscreenCreated = false;

async function handleYouTubeStart(tabId) {
  // Will be implemented in Phase 5:
  // 1. Create offscreen document for tabCapture
  // 2. Start audio capture + Deepgram streaming
  // 3. Buffer transcripts and feed into pipeline
  sendToTab(tabId, {
    type: 'STATUS_UPDATE',
    status: 'YouTube mode: coming soon. Use article mode for now.',
    phase: 'youtube_stub',
  });
}

function handleYouTubeStop() {
  // Clean up offscreen document
  if (offscreenCreated) {
    chrome.offscreen.closeDocument().catch(() => {});
    offscreenCreated = false;
  }
}

async function handleTranscriptChunk(tabId, text) {
  // Will be implemented in Phase 5
  // For now, just run the article pipeline on the chunk
  await handleArticleCheck(tabId, text, 'YouTube transcript', '');
}

// ─── Keep-alive for debugging ─────────────────────────────────────────────────
console.log('[Aletheia] Service worker loaded.');
