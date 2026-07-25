/**
 * content.js: Aletheia entry point.
 *
 * This is the main orchestrator that:
 *   1. Guards against double-injection
 *   2. Listens for pipeline results from the service worker
 *   3. Detects the page type and either auto-starts (YouTube) or
 *      shows a trigger button (articles)
 *
 * Depends on (loaded in order via manifest):
 *   - styles.js    → Aletheia.SHADOW_STYLES, Aletheia.VERDICT_COLORS
 *   - extractor.js → Aletheia.isYouTubePage, Aletheia.hasArticleContent,
 *                     Aletheia.extractArticleText
 *   - overlay.js   → Aletheia.Overlay
 */

(function () {
  'use strict';

  // Prevent double-injection (SPA navigations, etc.)
  if (window.__aletheiaInjected) return;
  window.__aletheiaInjected = true;

  const { isYouTubePage, hasArticleContent, extractArticleText, Overlay } = window.Aletheia;

  // ═══════════════════════════════════════════════════════════════════════════
  // TRIGGER BUTTON (article pages)
  // ═══════════════════════════════════════════════════════════════════════════

  function createTriggerButton(overlay) {
    const btn = document.createElement('button');
    btn.className = 'trigger-btn';
    btn.innerHTML = '<span class="trigger-icon">&#x2713;</span> Check Facts';

    btn.addEventListener('click', () => {
      btn.remove();
      startArticleCheck(overlay);
    });

    overlay.shadow.appendChild(btn);
    return btn;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ARTICLE CHECK FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  function startArticleCheck(overlay) {
    overlay.show();
    overlay.setStatus('Reading article…', true);
    overlay.setProgressIndeterminate();
    overlay.clearClaims();

    const { title, text } = extractArticleText();

    if (!text || text.length < 100) {
      overlay.setStatus('Error', false);
      overlay.clearProgress();
      overlay.showError(
        'Could not extract enough text from this page. The article may be paywalled, ' +
        'dynamically loaded, or this page may not contain an article.'
      );
      return;
    }

    // Send to service worker for pipeline processing
    chrome.runtime.sendMessage({
      type: 'CHECK_ARTICLE',
      text,
      title,
      url: location.href,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLING (results from service worker)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupMessageListener(overlay) {
    chrome.runtime.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'STATUS_UPDATE':
          overlay.setStatus(msg.status, true);
          if (msg.total) {
            overlay.setProgress(msg.current / msg.total);
          }
          break;

        case 'CLAIMS_FOUND':
          overlay.totalClaims = msg.count;
          overlay.setStatus(`Found ${msg.count} claims, checking...`, true);
          break;

        case 'CLAIM_RESULT':
          overlay.addClaimCard(msg);
          if (overlay.totalClaims > 0) {
            overlay.setProgress(overlay.claimCount / overlay.totalClaims);
          }
          break;

        case 'PIPELINE_COMPLETE':
          overlay.setStatus(`Done: ${overlay.claimCount} claims checked`, false);
          overlay.setProgress(1);
          setTimeout(() => overlay.clearProgress(), 2000);
          break;

        case 'PIPELINE_ERROR':
          overlay.setStatus('Error', false);
          overlay.clearProgress();
          overlay.showError(msg.error);
          break;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    // Don't run on extension pages, about:*, chrome:*, etc.
    if (!location.protocol.startsWith('http')) return;

    const overlay = new Overlay();
    setupMessageListener(overlay);

    if (isYouTubePage()) {
      // YouTube mode: show panel immediately
      overlay.show();
      overlay.setStatus('YouTube mode: starting...', true);
      chrome.runtime.sendMessage({ type: 'START_YOUTUBE' });
    } else if (hasArticleContent()) {
      // Article mode: show trigger button
      createTriggerButton(overlay);
    }
    // Otherwise: do nothing (page doesn't look like a news article)
  }

  // Wait for DOM readiness
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
