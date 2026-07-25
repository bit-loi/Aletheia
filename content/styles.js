/**
 * styles.js: Aletheia overlay theme constants & Shadow DOM stylesheet.
 *
 * Defines VERDICT_COLORS and SHADOW_STYLES for the overlay UI.
 * Pure Monochrome High-Contrast Neo-Brutalist Design (#000000 / #FFFFFF).
 */

window.Aletheia = window.Aletheia || {};

// ─── Verdict color palette ────────────────────────────────────────────────────

window.Aletheia.VERDICT_COLORS = {
  True:       { bg: '#064E3B', border: '#10B981', text: '#34D399', icon: 'TRUE' },
  False:      { bg: '#7F1D1D', border: '#EF4444', text: '#FCA5A5', icon: 'FALSE' },
  Misleading: { bg: '#78350F', border: '#F59E0B', text: '#FCD34D', icon: 'MISLEADING' },
  Unverified: { bg: '#27272A', border: '#71717A', text: '#E4E4E7', icon: 'UNVERIFIED' },
};

// ─── Shadow DOM stylesheet ────────────────────────────────────────────────────

window.Aletheia.SHADOW_STYLES = `
  :host {
    all: initial;
    position: fixed;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    z-index: 2147483647;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #ffffff;
  }

  /* ── Panel container (Fixed Viewport Neo-Brutalist Box) ── */
  .aletheia-panel {
    position: fixed;
    top: 100px;
    right: 24px;
    width: 370px;
    max-height: 72vh;
    background: #000000;
    border: 2.5px solid #ffffff;
    border-radius: 14px;
    box-shadow: 4px 4px 0px #ffffff;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
    transition: opacity 0.25s, transform 0.25s, background 0.2s, border-color 0.2s;
  }

  .aletheia-panel.hidden {
    opacity: 0;
    transform: translateY(-12px) scale(0.95);
    pointer-events: none;
  }

  .aletheia-panel.minimized {
    max-height: none;
  }

  /* ── Light Theme Overlay (Pure White & Black) ── */
  .aletheia-panel.light-theme {
    background: #ffffff;
    border-color: #000000;
    color: #000000;
    box-shadow: 4px 4px 0px #000000;
  }

  .aletheia-panel.light-theme .panel-header {
    background: #ffffff;
    border-bottom-color: #000000;
  }

  .aletheia-panel.light-theme .logo-text {
    color: #000000;
  }

  .aletheia-panel.light-theme .status-text {
    color: #000000;
  }

  .aletheia-panel.light-theme .ctrl-btn {
    background: #ffffff;
    border-color: #000000;
    color: #000000;
    box-shadow: 2px 2px 0px #000000;
  }

  .aletheia-panel.light-theme .ctrl-btn:hover {
    background: #000000;
    color: #ffffff;
  }

  .aletheia-panel.light-theme .progress-bar {
    background: #f4f4f5;
  }

  .aletheia-panel.light-theme .progress-fill {
    background: #000000;
  }

  .aletheia-panel.light-theme .claim-card {
    background: #ffffff;
    border-color: #000000;
    box-shadow: 3px 3px 0px #000000;
    color: #000000;
  }

  .aletheia-panel.light-theme .claim-text {
    color: #000000;
  }

  .aletheia-panel.light-theme .explanation {
    color: #27272a;
  }

  .aletheia-panel.light-theme .empty-state {
    color: #000000;
  }

  .aletheia-panel.light-theme .confidence-badge {
    background: #f4f4f5;
    color: #000000;
    border-color: #000000;
  }

  .aletheia-panel.light-theme .sources-toggle {
    color: #000000;
  }

  .aletheia-panel.light-theme .sources-list a {
    color: #000000;
    font-weight: bold;
  }

  /* ── Header ── */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 2px solid #ffffff;
    background: #000000;
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 260px;
    overflow: hidden;
  }

  .logo-text {
    font-size: 13px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }

  .status-text {
    font-size: 10px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 700;
    color: #ffffff;
    opacity: 0.9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 250px;
  }

  .status-text.active {
    opacity: 1;
    font-weight: 800;
  }

  .header-controls {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .ctrl-btn {
    width: 24px;
    height: 24px;
    border: 1.5px solid #ffffff;
    border-radius: 6px;
    background: #000000;
    color: #ffffff;
    font-size: 12px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    cursor: pointer;
    box-shadow: 2px 2px 0px #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.15s, color 0.15s;
  }

  .ctrl-btn:hover {
    background: #ffffff;
    color: #000000;
  }

  .ctrl-btn:active {
    transform: translate(1px, 1px);
    box-shadow: 1px 1px 0px #ffffff;
  }

  /* ── Progress bar ── */
  .progress-bar {
    height: 3px;
    background: #18181b;
    flex-shrink: 0;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #ffffff;
    width: 0%;
    transition: width 0.4s ease;
  }

  .progress-fill.indeterminate {
    width: 40%;
    animation: indeterminate 1.4s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* ── Claims feed ── */
  .claims-feed {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    scrollbar-width: thin;
    scrollbar-color: #ffffff #000000;
  }

  .claims-feed::-webkit-scrollbar { width: 6px; }
  .claims-feed::-webkit-scrollbar-track { background: #000000; }
  .claims-feed::-webkit-scrollbar-thumb { background: #ffffff; border-radius: 4px; }

  .empty-state {
    padding: 32px 16px;
    text-align: center;
    color: #ffffff;
    font-size: 13px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 700;
  }

  .empty-state .empty-icon {
    font-size: 28px;
    margin-bottom: 8px;
    font-weight: 800;
  }

  /* ── Claim card (Neo-Brutalist Box) ── */
  .claim-card {
    padding: 14px;
    margin-bottom: 12px;
    border-radius: 10px;
    border: 2px solid #ffffff;
    background: #000000;
    box-shadow: 3.5px 3.5px 0px #ffffff;
    animation: cardSlideIn 0.3s ease-out;
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
    flex-wrap: wrap;
  }

  .verdict-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border: 1.5px solid #ffffff;
    flex-shrink: 0;
  }

  .confidence-badge {
    font-size: 9.5px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    color: #ffffff;
    padding: 2px 6px;
    border-radius: 4px;
    background: #18181b;
    border: 1px solid #3f3f46;
  }

  .cache-badge {
    font-size: 9.5px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    color: #10b981;
    padding: 2px 6px;
    border-radius: 4px;
    background: #000000;
    border: 1px solid #10b981;
  }

  .claim-text {
    font-size: 13px;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 8px;
    line-height: 1.5;
  }

  .explanation {
    font-size: 12px;
    color: #ffffff;
    opacity: 0.9;
    line-height: 1.5;
    margin-bottom: 8px;
  }

  /* Sources toggle */
  .sources-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    text-transform: uppercase;
    color: #ffffff;
    cursor: pointer;
    border: none;
    background: none;
    padding: 4px 0;
    transition: opacity 0.2s;
  }

  .sources-toggle:hover {
    opacity: 0.8;
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
    margin-bottom: 6px;
  }

  .sources-list a {
    font-size: 11px;
    color: #ffffff;
    text-decoration: underline;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    word-break: break-all;
  }

  .sources-list a:hover {
    opacity: 0.8;
  }

  /* ── Error state ── */
  .error-card {
    padding: 14px;
    margin: 8px;
    border-radius: 10px;
    border: 2px solid #ef4444;
    background: #000000;
    box-shadow: 3.5px 3.5px 0px #ef4444;
    color: #f87171;
    font-size: 12px;
    font-weight: 600;
    animation: cardSlideIn 0.3s ease-out;
  }

  .error-card .error-title {
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  /* ── Minimized FAB ── */
  .aletheia-fab {
    position: fixed;
    top: 100px;
    right: 24px;
    width: 46px;
    height: 46px;
    border-radius: 12px;
    background: #000000;
    border: 2.5px solid #ffffff;
    box-shadow: 3.5px 3.5px 0px #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    pointer-events: auto;
    font-size: 18px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    color: #ffffff;
    transition: transform 0.15s, box-shadow 0.15s;
  }

  .aletheia-fab:hover {
    transform: translate(-1px, -1px);
    box-shadow: 5px 5px 0px #ffffff;
  }

  .aletheia-fab.hidden {
    display: none;
  }

  .badge-count {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ef4444;
    color: white;
    font-size: 10px;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    border: 1.5px solid #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* ── Spinner ── */
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid #ffffff;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
