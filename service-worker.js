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
import { CONFIG } from './config.js';

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
    (async () => {
      const tabId = sender.tab?.id || await getActiveYouTubeTabId();
      if (tabId) handleTranscriptChunk(tabId, msg.text);
    })();
    sendResponse({ ack: true });
  } else if (msg.type === 'OFFSCREEN_ERROR') {
    (async () => {
      const tabId = sender.tab?.id || await getActiveYouTubeTabId();
      if (tabId) {
        sendToTab(tabId, {
          type: 'STATUS_UPDATE',
          status: `Transcription Error: ${msg.error}`,
          phase: 'error',
        });
      }
    })();
    sendResponse({ ack: true });
  } else if (msg.type === 'STATUS_UPDATE' && !sender.tab) {
    // Offscreen documents have no sender.tab. Relay their capture/transcription
    // status to the YouTube tab instead of silently dropping it.
    getActiveYouTubeTabId().then((tabId) => {
      if (tabId) sendToTab(tabId, msg);
    });
    sendResponse({ ack: true });
  } else if (msg.type === 'GET_GEMINI_LIVE_TOKEN' && !sender.tab) {
    getGeminiLiveToken()
      .then((token) => sendResponse({ token }))
      .catch((err) => sendResponse({ error: err.message }));
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
        // KEEP IN SYNC with content_scripts[0].js in manifest.json. If these two
        // lists diverge, the overlay works on page load but breaks on dynamic
        // injection (or vice versa), which is painful to diagnose.
        files: [
          'shared/tokens.js',
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

async function getStoredLang() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['lang'], (data) => {
      resolve(data.lang || 'id');
    });
  });
}

// ─── Article Mode Handler ─────────────────────────────────────────────────────

async function handleArticleCheck(tabId, text, title, url, langOverride) {
  try {
    const lang = langOverride || await getStoredLang();
    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: lang === 'en' ? 'Extracting factual claims…' : 'Mengekstrak klaim faktual…',
      phase: 'extracting',
    });

    const claims = await extractClaims(text, lang);
    await processClaims(tabId, claims, title === 'YouTube transcript' ? 'youtube' : 'article', lang);
  } catch (err) {
    sendToTab(tabId, {
      type: 'PIPELINE_ERROR',
      error: `Pipeline failed: ${err.message}`,
    });
  }
}

async function processClaims(tabId, claims, mode, lang = 'id') {
  if (!claims?.length) {
    sendToTab(tabId, {
      type: 'PIPELINE_COMPLETE',
      claimsFound: 0,
      mode,
    });
    return;
  }

  const targetClaims = claims.slice(0, 2);
  sendToTab(tabId, { type: 'CLAIMS_FOUND', count: targetClaims.length });

  for (let i = 0; i < targetClaims.length; i++) {
    const claim = targetClaims[i];
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 200));

    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: lang === 'en' ? `Checking claim ${i + 1} of ${targetClaims.length}…` : `Memeriksa klaim ${i + 1} dari ${targetClaims.length}…`,
      phase: 'checking',
      current: i + 1,
      total: targetClaims.length,
    });

    try {
      const cached = await getCachedVerdict(claim);
      if (cached) {
        sendToTab(tabId, { type: 'CLAIM_RESULT', claim, ...cached, fromCache: true });
        continue;
      }
    } catch (_) {
      // Cache miss, continue to a live check.
    }

    let evidence = [];
    try {
      evidence = await retrieveEvidence(claim);
    } catch (err) {
      console.warn(`[Aletheia SW] Evidence retrieval failed for "${claim.slice(0, 50)}…":`, err);
    }

    try {
      const result = await generateVerdict(claim, evidence, lang);
      try {
        await cacheVerdict(claim, result);
      } catch (_) {
        // Caching failure is non-critical.
      }
      sendToTab(tabId, { type: 'CLAIM_RESULT', claim, ...result, fromCache: false });
    } catch (err) {
      console.warn(`[Aletheia SW] Verdict generation failed for "${claim.slice(0, 50)}…":`, err);
      sendToTab(tabId, {
        type: 'CLAIM_RESULT',
        claim,
        verdict: 'Unverified',
        explanation: lang === 'en' ? `Could not generate a verdict: ${err.message}` : `Tidak dapat membuat verifikasi: ${err.message}`,
        confidence: 'Low',
        key_sources: [],
        fromCache: false,
      });
    }
  }

  sendToTab(tabId, { type: 'PIPELINE_COMPLETE', mode });
}

// ─── YouTube Mode Handlers ───────────────────────────────────────────────────

const ACTIVE_YOUTUBE_TAB_KEY = 'activeYouTubeTabId';
let activeYouTubeTabId = null;

async function getActiveYouTubeTabId() {
  if (activeYouTubeTabId) return activeYouTubeTabId;
  const stored = await chrome.storage.session.get(ACTIVE_YOUTUBE_TAB_KEY);
  activeYouTubeTabId = stored[ACTIVE_YOUTUBE_TAB_KEY] || null;
  return activeYouTubeTabId;
}

async function getGeminiLiveToken() {
  const response = await fetch(`${CONFIG.PROXY_URL}/v1/gemini-live-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) {
    throw new Error(payload.error || 'Gemini Live is unavailable');
  }
  return payload.token;
}

async function handleYouTubeStart(tabId, streamId) {
  activeYouTubeTabId = tabId;
  await chrome.storage.session.set({ [ACTIVE_YOUTUBE_TAB_KEY]: tabId });

  let token;
  try {
    token = await getGeminiLiveToken();
  } catch (err) {
    sendToTab(tabId, {
      type: 'STATUS_UPDATE',
      status: err.message,
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
    // 2. Send capture start message to offscreen
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      streamId: streamId,
      geminiLiveToken: token,
      geminiLiveModel: CONFIG.GEMINI_LIVE_MODEL,
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
  activeYouTubeTabId = null;
  await chrome.storage.session.remove(ACTIVE_YOUTUBE_TAB_KEY);
}

async function handleTranscriptChunk(tabId, text) {
  // Spoken claims use the same extraction → evidence → verdict pipeline as an
  // article; the source text simply arrives in short transcript windows.
  await handleArticleCheck(tabId, text, 'YouTube transcript', '');
}

// ─── Keep-alive for debugging ─────────────────────────────────────────────────
console.log('[Aletheia] Service worker loaded.');
