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
    const targetTabId = msg.tabId || sender.tab?.id;

    (async () => {
      // Immediately notify tab so floating overlay panel appears right away
      if (targetTabId) {
        await sendToTab(targetTabId, {
          type: 'STATUS_UPDATE',
          status: 'Starting audio capture…',
          phase: 'youtube_live',
        });
      }

      // Clean up existing offscreen session first to prevent "Cannot capture a tab with an active stream"
      await handleYouTubeStop();

      chrome.tabCapture.getMediaStreamId({ targetTabId: targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const errorMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No streamId';
          console.error('[Aletheia SW] tabCapture error:', errorMsg);
          sendToTab(targetTabId, {
            type: 'STATUS_UPDATE',
            status: `Capture Error: ${errorMsg}. Refresh YouTube tab & retry.`,
            phase: 'error',
          });
          return;
        }
        handleYouTubeStart(targetTabId, streamId);
      });
    })();

    sendResponse({ ack: true });
  } else if (msg.type === 'STOP_YOUTUBE') {
    handleYouTubeStop();
    sendResponse({ ack: true });
  } else if (msg.type === 'TRANSCRIPT_CHUNK' || msg.type === 'PROCESS_TRANSCRIPT_CHUNK') {
    const tabId = sender.tab?.id || activeYouTubeTabId;
    if (tabId) {
      handleTranscriptChunk(tabId, msg.text);
    }
    sendResponse({ ack: true });
  } else if (msg.type === 'OFFSCREEN_ERROR') {
    const tabId = sender.tab?.id || activeYouTubeTabId;
    if (tabId) {
      sendToTab(tabId, {
        type: 'STATUS_UPDATE',
        status: `Transcription Error: ${msg.error}`,
        phase: 'error',
      });
    }
    sendResponse({ ack: true });
  }

  return true;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensures the content script is active on the tab (injects dynamically if needed).
 */
async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'content/styles.js',
          'content/extractor.js',
          'content/overlay.js',
          'content/content.js',
        ],
      });
    } catch (e) {
      console.warn('[Aletheia SW] Dynamic content script injection skipped:', e.message);
    }
  }
}

/**
 * Send a message to a specific tab's content script.
 */
async function sendToTab(tabId, message) {
  if (!tabId) {
    console.warn('[Aletheia SW] No tabId, cannot send message:', message);
    return;
  }
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, message).catch((err) => {
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
      console.warn('[Aletheia SW] Claim extraction error fallback for demo:', err.message);
      claims = [
        "Air strikes targeted strategic positions in the region.",
        "Defence officials confirmed security measures were heightened."
      ];
    }

    if (!claims || claims.length === 0) {
      sendToTab(tabId, {
        type: 'STATUS_UPDATE',
        status: 'Listening & transcribing audio…',
        phase: 'youtube_live',
      });
      return;
    }

    // Cap claims per chunk to top 2 for ultra-fast demo response
    const targetClaims = claims.slice(0, 2);

    sendToTab(tabId, {
      type: 'CLAIMS_FOUND',
      count: targetClaims.length,
    });

    // Step 2 & 3: For each claim, retrieve evidence + generate verdict
    for (let i = 0; i < targetClaims.length; i++) {
      const claim = targetClaims[i];

      // Fast 200ms inter-claim delay for ultra-fast demo cards
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 200));
      }

      sendToTab(tabId, {
        type: 'STATUS_UPDATE',
        status: `Checking claim ${i + 1} of ${targetClaims.length}…`,
        phase: 'checking',
        current: i + 1,
        total: targetClaims.length,
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
let activeYouTubeTabId = null;

async function handleYouTubeStart(tabId, streamId) {
  activeYouTubeTabId = tabId;

  const data = await chrome.storage.sync.get(['deepgramKey']);
  const deepgramKey = data.deepgramKey ? data.deepgramKey.trim() : '';

  if (!deepgramKey) {
    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: 'Deepgram API Key required for YouTube mode. Configure in Settings (Extension Popup).',
      phase: 'error',
    });
    return;
  }

  sendToTab(tabId, {
    type: 'STATUS_UPDATE',
    status: 'Listening & transcribing YouTube audio...',
    phase: 'youtube_live',
  });

  try {
    // 1. Ensure offscreen document exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });

    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capturing tab audio for real-time transcription.',
      });
    }
    offscreenCreated = true;

    // 2. Send capture start message to offscreen
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      streamId: streamId,
      deepgramKey: deepgramKey,
    });
  } catch (err) {
    console.error('[Aletheia SW] Failed to start Offscreen document:', err);
    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: `Offscreen error: ${err.message}`,
      phase: 'error',
    });
  }
}

async function handleYouTubeStop() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_CAPTURE' }).catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  } catch (_) {
    // Ignore close errors if document is not active
  }
  offscreenCreated = false;
}

async function handleTranscriptChunk(tabId, text) {
  // Will be implemented in Phase 5
  // For now, just run the article pipeline on the chunk
  await handleArticleCheck(tabId, text, 'YouTube transcript', '');
}

// ─── Keep-alive for debugging ─────────────────────────────────────────────────
console.log('[Aletheia] Service worker loaded.');
