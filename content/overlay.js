/**
 * overlay.js: Aletheia floating overlay panel.
 *
 * The AletheiaOverlay class creates and manages a Shadow DOM panel
 * injected into the page. It handles:
 *   - Panel show / minimize / close states
 *   - Status text and progress bar updates
 *   - Rendering color-coded claim cards with expandable sources
 *   - Error display
 *
 * Depends on: styles.js (SHADOW_STYLES, VERDICT_COLORS)
 * Loaded before: content.js
 */

window.Aletheia = window.Aletheia || {};

window.Aletheia.Overlay = class AletheiaOverlay {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.panel = null;
    this.fab = null;
    this.claimsFeed = null;
    this.statusEl = null;
    this.progressFill = null;
    this.isMinimized = false;
    this.claimCount = 0;
    this.totalClaims = 0;
    this._inject();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  /** Create Shadow DOM host and inject panel + FAB. */
  _inject() {
    this.host = document.createElement('aletheia-root');
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = window.Aletheia.SHADOW_STYLES;
    this.shadow.appendChild(style);

    // Build panel
    this.panel = this._buildPanel();
    this.shadow.appendChild(this.panel);

    // Build minimized FAB
    this.fab = this._buildFAB();
    this.shadow.appendChild(this.fab);

    // Start hidden
    this.panel.classList.add('hidden');
    this.fab.classList.add('hidden');

    this._initTheme();

    document.documentElement.appendChild(this.host);
  }

  /** Sync theme from storage & listen for live changes */
  _initTheme() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['theme'], (data) => {
        if (data && data.theme === 'light') {
          this.panel.classList.add('light-theme');
        }
      });
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes.theme) {
          if (changes.theme.newValue === 'light') {
            this.panel.classList.add('light-theme');
          } else {
            this.panel.classList.remove('light-theme');
          }
        }
      });
    }
  }

  /** Construct the main panel DOM. */
  _buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'aletheia-panel';

    panel.innerHTML = `
      <div class="panel-header">
        <div class="header-left">
          <span class="logo-text">Aletheia</span>
          <span class="status-text" id="al-status">Ready</span>
        </div>
        <div class="header-controls">
          <button class="ctrl-btn" id="al-minimize" title="Minimize">−</button>
          <button class="ctrl-btn" id="al-close" title="Close">×</button>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" id="al-progress"></div>
      </div>
      <div class="claims-feed" id="al-claims">
        <div class="empty-state">
          <div class="empty-icon">?</div>
          <div>Waiting to analyze…</div>
        </div>
      </div>
    `;

    // Wire up controls
    this.statusEl = panel.querySelector('#al-status');
    this.claimsFeed = panel.querySelector('#al-claims');
    this.progressFill = panel.querySelector('#al-progress');

    panel.querySelector('#al-minimize').addEventListener('click', () => this.minimize());
    panel.querySelector('#al-close').addEventListener('click', () => this.close());

    // Make panel header draggable
    const header = panel.querySelector('.panel-header');
    this._makeDraggable(header, panel);

    return panel;
  }

  /** Construct the minimized floating action button. */
  _buildFAB() {
    const fab = document.createElement('div');
    fab.className = 'aletheia-fab hidden';
    fab.innerHTML = '<span style="color:#ffffff;font-weight:800;font-size:20px;font-family:\'Courier New\',Courier,monospace;">A</span>';
    fab.title = 'Show Aletheia panel';
    fab.addEventListener('click', () => this.expand());
    this._makeDraggable(fab, fab);
    return fab;
  }

  /** Make any target element draggable by dragging a handle. */
  _makeDraggable(handle, target) {
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    const onMouseDown = (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      const clickedBtn = path.find((el) => el.classList && el.classList.contains('ctrl-btn'));
      if (clickedBtn) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = target.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      target.style.position = 'fixed';
      target.style.left = `${initialLeft}px`;
      target.style.top = `${initialTop}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';

      handle.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      const maxLeft = window.innerWidth - target.offsetWidth;
      const maxTop = window.innerHeight - target.offsetHeight;

      newLeft = Math.max(8, Math.min(newLeft, maxLeft - 8));
      newTop = Math.max(8, Math.min(newTop, maxTop - 8));

      target.style.left = `${newLeft}px`;
      target.style.top = `${newTop}px`;
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        handle.style.cursor = 'grab';
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);
      }
    };

    handle.addEventListener('mousedown', onMouseDown);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  show() {
    this.panel.classList.remove('hidden');
    this.fab.classList.add('hidden');
    this.isMinimized = false;
  }

  minimize() {
    this.panel.classList.add('hidden');
    this.fab.classList.remove('hidden');
    this.isMinimized = true;
  }

  expand() {
    this.panel.classList.remove('hidden');
    this.fab.classList.add('hidden');
    this.isMinimized = false;
  }

  close() {
    this.panel.classList.add('hidden');
    this.fab.classList.add('hidden');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS & PROGRESS
  // ═══════════════════════════════════════════════════════════════════════════

  setStatus(text, isActive = false) {
    if (this.statusEl) {
      this.statusEl.textContent = text;
      this.statusEl.className = 'status-text' + (isActive ? ' active' : '');
    }
  }

  setProgress(fraction) {
    if (this.progressFill) {
      this.progressFill.classList.remove('indeterminate');
      this.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    }
  }

  setProgressIndeterminate() {
    if (this.progressFill) {
      this.progressFill.classList.add('indeterminate');
      this.progressFill.style.width = '';
    }
  }

  clearProgress() {
    if (this.progressFill) {
      this.progressFill.classList.remove('indeterminate');
      this.progressFill.style.width = '0%';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTENT RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  clearClaims() {
    if (this.claimsFeed) {
      this.claimsFeed.innerHTML = '';
    }
    this.claimCount = 0;
  }

  /**
   * Render a single claim card and prepend it to the feed (newest first).
   *
   * @param {{ claim: string, verdict: string, explanation: string,
   *           confidence: string, key_sources: string[], fromCache: boolean }} data
   */
  addClaimCard({ claim, verdict, explanation, confidence, key_sources, fromCache }) {
    // Remove empty state if present
    const empty = this.claimsFeed.querySelector('.empty-state');
    if (empty) empty.remove();

    this.claimCount++;
    const colors = window.Aletheia.VERDICT_COLORS[verdict] || window.Aletheia.VERDICT_COLORS.Unverified;

    const card = document.createElement('div');
    card.className = 'claim-card';
    card.style.borderColor = colors.border + '33'; // 20% opacity border

    const sourcesId = `sources-${this.claimCount}`;

    const sourcesHtml =
      key_sources && key_sources.length > 0
        ? key_sources
            .map((url) => {
              let displayUrl;
              try {
                displayUrl = new URL(url).hostname;
              } catch {
                displayUrl = url.slice(0, 40);
              }
              return `<li><a href="${this._esc(url)}" target="_blank" rel="noopener">${this._esc(displayUrl)}</a></li>`;
            })
            .join('')
        : '<li style="color: #475569;">No sources available</li>';

    card.innerHTML = `
      <div class="card-header">
        <span class="verdict-badge" style="background: ${colors.bg}; color: ${colors.text};">
          ${colors.icon} ${verdict}
        </span>
        <span class="confidence-badge">${confidence} confidence</span>
        ${fromCache ? '<span class="cache-badge">cached</span>' : ''}
      </div>
      <div class="claim-text">${this._esc(claim)}</div>
      <div class="explanation">${this._esc(explanation)}</div>
      <button class="sources-toggle" data-target="${sourcesId}">
        <span class="arrow">▶</span>
        Sources (${key_sources ? key_sources.length : 0})
      </button>
      <ul class="sources-list" id="${sourcesId}">
        ${sourcesHtml}
      </ul>
    `;

    // Wire sources toggle
    const toggle = card.querySelector('.sources-toggle');
    const list = card.querySelector('.sources-list');
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('expanded');
      list.classList.toggle('visible');
    });

    this.claimsFeed.prepend(card);
  }

  /** Display an error message in the claims feed. */
  showError(message) {
    const empty = this.claimsFeed.querySelector('.empty-state');
    if (empty) empty.remove();

    const card = document.createElement('div');
    card.className = 'error-card';
    card.innerHTML = `
      <div class="error-title">Error</div>
      <div>${this._esc(message)}</div>
    `;
    this.claimsFeed.prepend(card);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Escape HTML entities to prevent XSS via user-generated content. */
  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
