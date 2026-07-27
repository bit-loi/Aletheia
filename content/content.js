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
  // ARTICLE CHECK FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  function startArticleCheck(overlay) {
    overlay.show();

    // No key pre-flight: the pipeline falls back to the hosted proxy, so the
    // extension works on install with nothing configured. If both the proxy and
    // any personal keys fail, the service worker reports it as a real
    // PIPELINE_ERROR and the overlay shows that, with a retry.
    overlay.setStatus('Reading article…', true);
    overlay.setProgressIndeterminate();
    overlay.clearClaims();

    const { title, text } = extractArticleText();

    if (!text || text.length < 100) {
      overlay.setStatus('Error', false);
      overlay.clearProgress();
      overlay.showError(
        'Could not extract enough text from this page. The article may be paywalled, ' +
        'dynamically loaded, or this page may not contain an article.',
        { onRetry: () => startArticleCheck(overlay) }
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
  // MESSAGE HANDLING (results from service worker & popup triggers)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupMessageListener(overlay) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'START_ARTICLE_CHECK') {
        startArticleCheck(overlay);
        return;
      }

      switch (msg.type) {
        case 'STATUS_UPDATE':
          overlay.show();
          overlay.setStatus(msg.status, true);
          if (msg.total) {
            overlay.setProgress(msg.current / msg.total);
          }
          break;

        case 'CLAIMS_FOUND':
          overlay.show();
          overlay.totalClaims = msg.count;
          overlay.setStatus(`Found ${msg.count} claims, checking...`, true);
          // Reserve a slot per expected claim so results resolve in place.
          overlay.renderSkeletons(msg.count);
          break;

        case 'CLAIM_RESULT':
          overlay.show();
          overlay.addClaimCard(msg);
          if (overlay.totalClaims > 0) {
            overlay.setProgress(overlay.claimCount / overlay.totalClaims);
          }
          break;

        case 'PIPELINE_COMPLETE':
          overlay.show();
          // claimsFound === 0 is a terminal state, not a failure. Without it the
          // overlay used to sit on "Listening & transcribing audio…" forever.
          if (msg.claimsFound === 0 && overlay.claimCount === 0) {
            overlay.setStatus('No claims found', false);
            overlay.clearProgress();
            overlay.renderNoClaims(msg.mode);
            break;
          }
          overlay.setStatus(`Done: ${overlay.claimCount} claims checked`, false);
          overlay.setProgress(1);
          setTimeout(() => overlay.clearProgress(), 2000);
          break;

        case 'PIPELINE_ERROR':
          overlay.show();
          overlay.setStatus('Error', false);
          overlay.clearProgress();
          overlay.showError(msg.error, {
            onRetry: () => startArticleCheck(overlay),
          });
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

    // Clean up any stale roots left over from previous script injections
    document.querySelectorAll('aletheia-root').forEach((el) => el.remove());

    const overlay = new Overlay();
    setupMessageListener(overlay);

    // Overlay listener ready on all http/https pages, waiting for user trigger from popup
  }

  // Wait for DOM readiness
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
