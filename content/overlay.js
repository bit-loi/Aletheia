/**
 * overlay.js: Aletheia floating overlay panel.
 *
 * Structure follows the "glass chrome, opaque content" rule:
 *
 *   .al-panel     transparent layout shell (NO background, NO overflow clip)
 *   .al-chrome      glass: header bar, drag grip, controls
 *   .al-progress    determinate / indeterminate bar
 *   .al-body        OPAQUE surface, owns the scroll clipping
 *   .al-feed          claim cards, chronological
 *   .al-sr          visually-hidden live region for concise announcements
 *   .al-fab       glass pill shown while minimized
 *
 * The panel itself must stay transparent and must never animate opacity: an
 * ancestor with opacity < 1 becomes a backdrop root, and a descendant's
 * backdrop-filter would then sample nothing, making the glass flatly vanish
 * mid-transition. Panel show/hide animates transform + visibility instead.
 *
 * Depends on: tokens.js (tokensCSS), styles.js (SHADOW_STYLES, VERDICT_META)
 * Loaded before: content.js
 */

window.Aletheia = window.Aletheia || {};

const POSITION_KEY = 'overlayPos';
const DRAG_THRESHOLD = 4; // px before a pointer-down counts as a drag, not a click

window.Aletheia.Overlay = class AletheiaOverlay {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.panel = null;
    this.fab = null;
    this.claimsFeed = null;
    this.statusEl = null;
    this.progressEl = null;
    this.progressFill = null;
    this.liveRegion = null;
    this.isMinimized = false;
    this.claimCount = 0;
    this.totalClaims = 0;
    this._inject();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  _inject() {
    this.host = document.createElement('aletheia-root');
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = window.Aletheia.SHADOW_STYLES;
    this.shadow.appendChild(style);

    this.panel = this._buildPanel();
    this.shadow.appendChild(this.panel);

    this.fab = this._buildFAB();
    this.shadow.appendChild(this.fab);

    this.panel.classList.add('is-hidden');
    this.fab.classList.add('is-hidden');

    this._initTheme();
    this._restorePosition();

    document.documentElement.appendChild(this.host);
  }

  /**
   * Sync theme from storage and listen for live changes.
   *
   * The class goes on the HOST, not the panel: the FAB is a sibling of the
   * panel, so a panel-scoped theme class left the minimized pill stuck in dark
   * colors. Host scoping also lets the token sheet use :host(.light-theme).
   */
  _initTheme() {
    const apply = (theme) => this.host.classList.toggle('light-theme', theme === 'light');

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['theme'], (data) => apply(data && data.theme));
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.theme) apply(changes.theme.newValue);
      });
    }
  }

  _buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'al-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Aletheia fact check');
    panel.tabIndex = -1;

    panel.innerHTML = `
      <div class="al-chrome">
        <button class="al-grip" type="button"
                aria-label="Move panel. Use arrow keys to reposition.">
          <span class="al-grip__dots" aria-hidden="true"></span>
        </button>
        <div class="al-ident">
          <span class="al-brand">Aletheia</span>
          <span class="al-status" id="al-status" role="status" aria-live="polite" aria-atomic="true">Ready</span>
        </div>
        <div class="al-actions">
          <button class="al-ctrl" id="al-minimize" type="button" aria-label="Minimize panel">
            <span aria-hidden="true">&minus;</span>
          </button>
          <button class="al-ctrl" id="al-close" type="button" aria-label="Close panel">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
      </div>
      <div class="al-progress" id="al-progress" role="progressbar"
           aria-valuemin="0" aria-valuemax="100" aria-label="Fact check progress">
        <div class="al-progress__fill" id="al-progress-fill"></div>
      </div>
      <div class="al-body">
        <div class="al-feed" id="al-claims" role="log"></div>
      </div>
      <div class="al-sr" id="al-sr" role="status" aria-live="polite" aria-atomic="true"></div>
    `;

    this.statusEl = panel.querySelector('#al-status');
    this.claimsFeed = panel.querySelector('#al-claims');
    this.progressEl = panel.querySelector('#al-progress');
    this.progressFill = panel.querySelector('#al-progress-fill');
    this.liveRegion = panel.querySelector('#al-sr');

    panel.querySelector('#al-minimize').addEventListener('click', () => this.minimize());
    panel.querySelector('#al-close').addEventListener('click', () => this.close());

    // Escape minimizes rather than closes: closing leaves no way back without a
    // page reload, which is a harsh outcome for a stray keypress.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.minimize(); }
    });

    const grip = panel.querySelector('.al-grip');
    this._makeDraggable(grip, panel, { keyboard: true });
    this._makeDraggable(panel.querySelector('.al-chrome'), panel);

    this.renderEmptyState();
    return panel;
  }

  _buildFAB() {
    const fab = document.createElement('button');
    fab.className = 'al-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Open Aletheia panel');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<span class="al-fab__glyph" aria-hidden="true">A</span>';
    // A drag ends in a click, so _makeDraggable swallows that trailing click in
    // the capture phase; without it the FAB re-expanded on every reposition.
    fab.addEventListener('click', () => this.expand());
    this._makeDraggable(fab, fab);
    return fab;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAG
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make `target` draggable by `handle`.
   *
   * Pointer Events rather than mouse events, so touch and pen work and pointer
   * capture removes the manual window-listener bookkeeping. A movement
   * threshold suppresses the trailing click, which previously made the FAB
   * impossible to reposition: every drag ended in a click that re-expanded it.
   */
  _makeDraggable(handle, target, { keyboard = false } = {}) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    const place = (left, top) => {
      const maxLeft = window.innerWidth - target.offsetWidth - 8;
      const maxTop = window.innerHeight - target.offsetHeight - 8;
      const l = Math.max(8, Math.min(left, maxLeft));
      const t = Math.max(8, Math.min(top, maxTop));
      target.style.left = `${l}px`;
      target.style.top = `${t}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      return { left: l, top: t };
    };

    handle.addEventListener('pointerdown', (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.some((el) => el.classList && el.classList.contains('al-ctrl'))) return;

      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = target.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      handle.setPointerCapture(e.pointerId);
      target.classList.add('is-dragging');
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      place(originLeft + dx, originTop + dy);
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      target.classList.remove('is-dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        this._savePosition(target);
        // Swallow the click that closes out this drag gesture.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        handle.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => handle.removeEventListener('click', swallow, true), 0);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    if (keyboard) {
      handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 48 : 16;
        const rect = target.getBoundingClientRect();
        let handled = true;
        switch (e.key) {
          case 'ArrowLeft':  place(rect.left - step, rect.top); break;
          case 'ArrowRight': place(rect.left + step, rect.top); break;
          case 'ArrowUp':    place(rect.left, rect.top - step); break;
          case 'ArrowDown':  place(rect.left, rect.top + step); break;
          case 'Home':
            target.style.left = '';
            target.style.top = '';
            target.style.right = '';
            target.style.bottom = '';
            break;
          default: handled = false;
        }
        if (handled) {
          e.preventDefault();
          this._savePosition(target);
        }
      });
    }
  }

  _savePosition(target) {
    if (target !== this.panel) return; // only the panel's position is restored
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set({
      [POSITION_KEY]: { left: target.style.left, top: target.style.top },
    });
  }

  _restorePosition() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get([POSITION_KEY], (data) => {
      const pos = data && data[POSITION_KEY];
      if (!pos || !pos.left) return;
      this.panel.style.left = pos.left;
      this.panel.style.top = pos.top;
      this.panel.style.right = 'auto';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  show() {
    this.panel.classList.remove('is-hidden');
    this.fab.classList.add('is-hidden');
    this.fab.setAttribute('aria-expanded', 'true');
    this.isMinimized = false;
  }

  minimize() {
    this._setFabOrigin();
    this.panel.classList.add('is-hidden');
    this.fab.classList.remove('is-hidden');
    this.fab.setAttribute('aria-expanded', 'false');
    this.isMinimized = true;
    this.fab.focus({ preventScroll: true });
  }

  expand() {
    this.show();
    this.panel.focus({ preventScroll: true });
  }

  close() {
    this.panel.classList.add('is-hidden');
    this.fab.classList.add('is-hidden');
  }

  /**
   * Point the panel's collapse transform at the FAB.
   *
   * Cheaper and less fragile than a real FLIP, while still preserving object
   * identity between the two forms.
   */
  _setFabOrigin() {
    const p = this.panel.getBoundingClientRect();
    const f = this.fab.getBoundingClientRect();
    if (!p.width || !f.width) return;
    this.panel.style.setProperty('--al-origin-x', `${f.left + f.width / 2 - p.left}px`);
    this.panel.style.setProperty('--al-origin-y', `${f.top + f.height / 2 - p.top}px`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS & PROGRESS
  // ═══════════════════════════════════════════════════════════════════════════

  setStatus(text, isActive = false) {
    if (!this.statusEl) return;
    if (this.statusEl.textContent === text) return;
    this.statusEl.classList.add('is-swapping');
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('is-active', isActive);
    requestAnimationFrame(() => this.statusEl.classList.remove('is-swapping'));
  }

  setProgress(fraction) {
    if (!this.progressFill) return;
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    this.progressEl.classList.add('is-visible');
    this.progressEl.classList.remove('is-indeterminate');
    this.progressEl.setAttribute('aria-valuenow', String(pct));
    this.progressEl.removeAttribute('aria-busy');
    this.progressFill.style.width = `${pct}%`;
  }

  setProgressIndeterminate() {
    if (!this.progressFill) return;
    this.progressEl.classList.add('is-visible', 'is-indeterminate');
    this.progressEl.removeAttribute('aria-valuenow');
    this.progressEl.setAttribute('aria-busy', 'true');
    this.progressFill.style.width = '';
  }

  clearProgress() {
    if (!this.progressFill) return;
    this.progressEl.classList.remove('is-visible', 'is-indeterminate');
    this.progressEl.removeAttribute('aria-busy');
    this.progressFill.style.width = '0%';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTENT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Announce concisely. The feed itself is not a live region: reading whole
   *  cards aloud on every result is unusable. */
  announce(text) {
    if (this.liveRegion) this.liveRegion.textContent = text;
  }

  clearClaims() {
    if (!this.claimsFeed) return;
    this.claimsFeed.innerHTML = '';
    this.claimCount = 0;
  }

  /**
   * Swap the feed's whole contents.
   *
   * Resets claimCount with it. Every terminal state (error, setup, no-claims,
   * skeletons) routes through here, and leaving the counter stale meant
   * "Done: N claims checked" could report a count from a previous run, and the
   * `claimCount === 0` guard on the no-claims state would silently never fire.
   */
  _replaceFeed(html) {
    this.claimsFeed.innerHTML = html;
    this.claimCount = 0;
  }

  renderEmptyState() {
    this._replaceFeed(`
      <div class="al-placeholder">
        <div class="al-placeholder__title">Nothing checked yet</div>
        <div class="al-placeholder__body">Run a check from the Aletheia toolbar menu to see claims and verdicts here.</div>
      </div>
    `);
  }

  /** No API keys configured. The extension is inert without them, so say so
   *  rather than failing silently at the first request. */
  renderSetupState() {
    this._replaceFeed(`
      <div class="al-placeholder">
        <div class="al-placeholder__title">Setup needed</div>
        <div class="al-placeholder__body">Add your NVIDIA and Tavily API keys in the Aletheia toolbar menu, then run the check again.</div>
      </div>
    `);
    this.announce('Aletheia needs API keys before it can check claims.');
  }

  renderNoClaims(mode) {
    const body = mode === 'youtube'
      ? 'No new checkable claims in this segment. Still listening.'
      : 'No verifiable factual claims were found on this page. Opinion and commentary are skipped by design.';
    this._replaceFeed(`
      <div class="al-placeholder">
        <div class="al-placeholder__title">No claims to check</div>
        <div class="al-placeholder__body">${this._esc(body)}</div>
      </div>
    `);
    this.announce(body);
  }

  /** Reserve one slot per expected claim so results resolve in place. */
  renderSkeletons(count) {
    const n = Math.max(0, Math.min(Number(count) || 0, 8));
    if (!n) return;
    this._replaceFeed(
      Array.from({ length: n }, () => `
        <div class="al-skeleton" aria-hidden="true">
          <div class="al-skeleton__rail"></div>
          <div class="al-skeleton__lines">
            <span class="al-skeleton__line al-skeleton__line--badge"></span>
            <span class="al-skeleton__line"></span>
            <span class="al-skeleton__line al-skeleton__line--short"></span>
          </div>
        </div>
      `).join('')
    );
  }

  _consumeSkeleton() {
    const skel = this.claimsFeed.querySelector('.al-skeleton');
    if (skel) { skel.remove(); return; }
    const placeholder = this.claimsFeed.querySelector('.al-placeholder');
    if (placeholder) placeholder.remove();
  }

  /**
   * Render a claim card, appended chronologically.
   *
   * Verdict colour is carried by data-verdict and resolved in CSS, not by
   * inline styles. Colour appears only on the rail, the badge ink and the dot;
   * it is always backed by the verdict word and a rail fill pattern, so the
   * result survives grayscale and colour-vision deficiency.
   */
  addClaimCard({ claim, verdict, explanation, confidence, key_sources, fromCache }) {
    this._consumeSkeleton();
    this.claimCount++;

    const meta = window.Aletheia.VERDICT_META[verdict] || window.Aletheia.VERDICT_META.Unverified;
    const sources = Array.isArray(key_sources) ? key_sources : [];
    const sourcesId = `al-sources-${this.claimCount}`;

    const card = document.createElement('article');
    card.className = 'al-card';
    card.dataset.verdict = meta.key;
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', `${meta.label}, ${confidence || 'unknown'} confidence. ${claim}`);
    card.style.setProperty('--al-card-index', String(this.claimCount));

    const sourceItems = sources.length
      ? sources.map((url) => {
          let label;
          try { label = new URL(url).hostname.replace(/^www\./, ''); }
          catch { label = String(url).slice(0, 40); }
          return `<li><a href="${this._esc(url)}" target="_blank" rel="noopener noreferrer">${this._esc(label)}</a></li>`;
        }).join('')
      : '<li class="al-sources__empty">No sources retrieved</li>';

    card.innerHTML = `
      <span class="al-card__rail" aria-hidden="true"></span>
      <div class="al-card__main">
        <div class="al-card__head">
          <span class="al-badge">
            <span class="al-badge__dot" aria-hidden="true"></span>${this._esc(meta.label)}
          </span>
          ${confidence ? `<span class="al-meter" title="${this._esc(confidence)} confidence">
            ${this._meterHtml(confidence)}<span class="al-meter__label">${this._esc(confidence)}</span>
          </span>` : ''}
          ${fromCache ? '<span class="al-chip">cached</span>' : ''}
        </div>
        <p class="al-claim">${this._esc(claim)}</p>
        <p class="al-explain">${this._esc(explanation)}</p>
        <button class="al-sources__toggle" type="button"
                aria-expanded="false" aria-controls="${sourcesId}">
          <span class="al-sources__arrow" aria-hidden="true"></span>Sources (${sources.length})
        </button>
        <div class="al-sources__wrap" id="${sourcesId}">
          <ul class="al-sources__list">${sourceItems}</ul>
        </div>
      </div>
    `;

    const toggle = card.querySelector('.al-sources__toggle');
    const wrap = card.querySelector('.al-sources__wrap');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      wrap.classList.toggle('is-open', !open);
    });

    this.claimsFeed.appendChild(card);
    this.announce(`${meta.label}, ${confidence || 'unknown'} confidence. ${String(claim).slice(0, 80)}`);
  }

  /** Three-segment monochrome meter. Keeps confidence glanceable without
   *  competing with the verdict rail for colour attention. */
  _meterHtml(confidence) {
    const filled = { high: 3, medium: 2, low: 1 }[String(confidence).toLowerCase()] || 0;
    return Array.from({ length: 3 }, (_, i) =>
      `<span class="al-meter__seg${i < filled ? ' is-on' : ''}" aria-hidden="true"></span>`
    ).join('');
  }

  /** Error state, with a retry affordance when the caller can offer one. */
  showError(message, { onRetry } = {}) {
    this._replaceFeed(`
      <div class="al-error">
        <div class="al-error__title">Check failed</div>
        <div class="al-error__body">${this._esc(message)}</div>
        ${onRetry ? '<button class="al-retry" type="button">Try again</button>' : ''}
      </div>
    `);
    if (onRetry) {
      this.claimsFeed.querySelector('.al-retry').addEventListener('click', () => onRetry());
    }
    this.announce(`Check failed. ${message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Escape HTML entities to prevent XSS via model- or page-derived content. */
  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }
};
