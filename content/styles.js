/**
 * styles.js: Aletheia overlay theme constants.
 *
 * Defines VERDICT_COLORS and SHADOW_STYLES used by the overlay UI.
 * Loaded first in the content script chain.
 */

window.Aletheia = window.Aletheia || {};

// ─── Verdict color palette ────────────────────────────────────────────────────

window.Aletheia.VERDICT_COLORS = {
  True:       { bg: 'rgba(34, 197, 94, 0.15)',  border: '#22c55e', text: '#4ade80', icon: 'T' },
  False:      { bg: 'rgba(239, 68, 68, 0.15)',  border: '#ef4444', text: '#f87171', icon: 'F' },
  Misleading: { bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b', text: '#fbbf24', icon: '!' },
  Unverified: { bg: 'rgba(156, 163, 175, 0.15)', border: '#6b7280', text: '#9ca3af', icon: '?' },
};

// ─── Shadow DOM stylesheet ────────────────────────────────────────────────────
// Everything here is injected inside the shadow root, fully isolated from the
// host page's CSS. It's a long string by necessity (no external sheet inside
// shadow DOM without a build step.

window.Aletheia.SHADOW_STYLES = `
  :host {
    all: initial;
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #e2e8f0;
  }

  /* ── Panel container ── */
  .aletheia-panel {
    width: 380px;
    max-height: 70vh;
    background: rgba(15, 15, 25, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 212, 170, 0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: opacity 0.3s, transform 0.3s;
  }

  .aletheia-panel.hidden {
    opacity: 0;
    transform: translateY(-12px) scale(0.95);
    pointer-events: none;
  }

  .aletheia-panel.minimized {
    max-height: none;
  }

  /* ── Light Theme ── */
  .aletheia-panel.light-theme {
    background: rgba(255, 255, 255, 0.96);
    border-color: rgba(0, 0, 0, 0.12);
    color: #0f172a;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 168, 132, 0.1);
  }

  .aletheia-panel.light-theme .panel-header {
    border-bottom-color: rgba(0, 0, 0, 0.08);
  }

  .aletheia-panel.light-theme .logo-text {
    color: #00a884;
  }

  .aletheia-panel.light-theme .status-text {
    background: rgba(0, 0, 0, 0.05);
    color: #64748b;
  }

  .aletheia-panel.light-theme .ctrl-btn {
    color: #64748b;
  }

  .aletheia-panel.light-theme .ctrl-btn:hover {
    color: #0f172a;
    background: rgba(0, 0, 0, 0.06);
  }

  .aletheia-panel.light-theme .progress-bar {
    background: rgba(0, 0, 0, 0.06);
  }

  .aletheia-panel.light-theme .claim-card {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.08);
  }

  .aletheia-panel.light-theme .claim-text {
    color: #1e293b;
  }

  .aletheia-panel.light-theme .explanation {
    color: #475569;
  }

  .aletheia-panel.light-theme .empty-state {
    color: #64748b;
  }

  /* ── Header ── */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .logo-text {
    font-size: 15px;
    font-weight: 700;
    color: #00D4AA;
    letter-spacing: -0.3px;
  }

  .status-text {
    font-size: 12px;
    color: #64748b;
    margin-top: 1px;
  }

  .status-text.active {
    color: #00D4AA;
  }

  .header-controls {
    display: flex;
    gap: 4px;
  }

  .ctrl-btn {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: #94a3b8;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s, color 0.2s;
  }

  .ctrl-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #e2e8f0;
  }

  /* ── Progress bar ── */
  .progress-bar {
    height: 2px;
    background: rgba(255, 255, 255, 0.04);
    flex-shrink: 0;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00D4AA, #00b4d8);
    width: 0%;
    transition: width 0.5s ease;
  }

  .progress-fill.indeterminate {
    width: 40%;
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* ── Claims feed ── */
  .claims-feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.1) transparent;
  }

  .claims-feed::-webkit-scrollbar { width: 4px; }
  .claims-feed::-webkit-scrollbar-track { background: transparent; }
  .claims-feed::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  .empty-state {
    padding: 32px 16px;
    text-align: center;
    color: #475569;
    font-size: 13px;
  }

  .empty-state .empty-icon {
    font-size: 32px;
    margin-bottom: 8px;
    opacity: 0.5;
  }

  /* ── Claim card ── */
  .claim-card {
    padding: 14px;
    margin-bottom: 8px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.02);
    animation: cardSlideIn 0.35s ease-out;
  }

  @keyframes cardSlideIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .verdict-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .confidence-badge {
    font-size: 10px;
    color: #64748b;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
  }

  .cache-badge {
    font-size: 10px;
    color: #00D4AA;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0, 212, 170, 0.1);
  }

  .claim-text {
    font-size: 13px;
    color: #cbd5e1;
    margin-bottom: 8px;
    line-height: 1.55;
  }

  .explanation {
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.5;
    margin-bottom: 8px;
  }

  /* Sources toggle */
  .sources-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #64748b;
    cursor: pointer;
    border: none;
    background: none;
    padding: 4px 0;
    font-family: inherit;
    transition: color 0.2s;
  }

  .sources-toggle:hover {
    color: #94a3b8;
  }

  .sources-toggle .arrow {
    font-size: 10px;
    transition: transform 0.2s;
  }

  .sources-toggle.expanded .arrow {
    transform: rotate(90deg);
  }

  .sources-list {
    display: none;
    margin-top: 6px;
    padding: 0;
    list-style: none;
  }

  .sources-list.visible {
    display: block;
  }

  .sources-list li {
    margin-bottom: 4px;
  }

  .sources-list a {
    font-size: 11px;
    color: #00D4AA;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    word-break: break-all;
    transition: color 0.2s;
  }

  .sources-list a:hover {
    color: #00e8bb;
    text-decoration: underline;
  }

  /* ── Error state ── */
  .error-card {
    padding: 14px;
    margin: 8px;
    border-radius: 12px;
    border: 1px solid rgba(239, 68, 68, 0.3);
    background: rgba(239, 68, 68, 0.08);
    color: #f87171;
    font-size: 13px;
    animation: cardSlideIn 0.35s ease-out;
  }

  .error-card .error-title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  /* ── Minimized fab ── */
  .aletheia-fab {
    width: 48px;
    height: 48px;
    border-radius: 14px;
    background: rgba(15, 15, 25, 0.96);
    border: 1px solid rgba(0, 212, 170, 0.3);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 20px;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .aletheia-fab:hover {
    transform: scale(1.08);
    box-shadow: 0 4px 24px rgba(0, 212, 170, 0.2);
  }

  .aletheia-fab.hidden {
    display: none;
  }

  .badge-count {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ef4444;
    color: white;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* ── Trigger button (for articles) ── */
  .trigger-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border: 1px solid rgba(0, 212, 170, 0.3);
    border-radius: 12px;
    background: rgba(15, 15, 25, 0.96);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    color: #00D4AA;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    transition: all 0.2s;
  }

  .trigger-btn:hover {
    background: rgba(0, 212, 170, 0.1);
    border-color: #00D4AA;
    box-shadow: 0 4px 24px rgba(0, 212, 170, 0.15);
    transform: translateY(-1px);
  }

  .trigger-btn:active {
    transform: scale(0.97);
  }

  .trigger-btn .trigger-icon {
    font-size: 16px;
  }

  /* ── Spinner ── */
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(0, 212, 170, 0.2);
    border-top-color: #00D4AA;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
