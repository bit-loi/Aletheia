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

// ─── Overlay i18n ─────────────────────────────────────────────────────────────
// Lightweight translations for overlay strings. The overlay runs in content
// script context, so we keep a minimal inline map and sync from storage.

const OVERLAY_STRINGS = {
  id: {
    ready: 'Siap',
    nothing_checked: 'Belum ada yang diperiksa',
    nothing_checked_body: 'Jalankan pemeriksaan dari menu toolbar Aletheia untuk melihat klaim dan hasil di sini.',
    service_unavailable: 'Layanan tidak tersedia',
    service_unavailable_body: 'Aletheia tidak dapat menghubungi proxy bersama. Periksa koneksi Anda dan coba lagi.',
    no_claims: 'Tidak ada klaim untuk diperiksa',
    no_claims_youtube: 'Tidak ada klaim baru yang dapat diperiksa di segmen ini. Masih mendengarkan.',
    no_claims_article: 'Tidak ditemukan klaim faktual yang dapat diverifikasi di halaman ini. Opini dan komentar dilewati secara desain.',
    check_failed: 'Pemeriksaan gagal',
    try_again: 'Coba lagi',
    sources: (n) => `Sumber (${n})`,
    no_sources: 'Tidak ada sumber yang ditemukan',
    cached: 'di-cache',
  },
  en: {
    ready: 'Ready',
    nothing_checked: 'Nothing checked yet',
    nothing_checked_body: 'Run a check from the Aletheia toolbar menu to see claims and verdicts here.',
    service_unavailable: 'Service unavailable',
    service_unavailable_body: 'Aletheia could not reach its shared proxy. Check your connection and try again.',
    no_claims: 'No claims to check',
    no_claims_youtube: 'No new checkable claims in this segment. Still listening.',
    no_claims_article: 'No verifiable factual claims were found on this page. Opinion and commentary are skipped by design.',
    check_failed: 'Check failed',
    try_again: 'Try again',
    sources: (n) => `Sources (${n})`,
    no_sources: 'No sources retrieved',
    cached: 'cached',
  },
  ja: {
    ready: '準備完了',
    nothing_checked: 'まだチェックされていません',
    nothing_checked_body: 'Aletheiaツールバーのメニューからチェックを実行すると、クライアントと判定がここに表示されます。',
    service_unavailable: 'サービスが利用できません',
    service_unavailable_body: 'Aletheiaが共有プロキシに接続できませんでした。接続を確認して、もう一度お試しください。',
    no_claims: 'チェックするクライアントがありません',
    no_claims_youtube: 'このセグメントにチェック可能な新しいクライアントはありません。リスニングを続行中。',
    no_claims_article: 'このページに検証可能な事実クライアントが見つかりませんでした。意見やコメンタリーは設計上スキップされます。',
    check_failed: 'チェック失敗',
    try_again: '再試行',
    sources: (n) => `ソース (${n})`,
    no_sources: 'ソースが取得されませんでした',
    cached: 'キャッシュ済み',
  },
  ko: {
    ready: '준비 완료',
    nothing_checked: '아직 확인된 것이 없습니다',
    nothing_checked_body: 'Aletheia 툴바 메뉴에서 확인을 실행하면 주장과 판정이 여기에 표시됩니다.',
    service_unavailable: '서비스를 사용할 수 없음',
    service_unavailable_body: 'Aletheia가 공유 프록시에 연결할 수 없습니다. 연결을 확인한 후 다시 시도하세요.',
    no_claims: '확인할 주장이 없습니다',
    no_claims_youtube: '이 세그먼트에 확인 가능한 새로운 주장이 없습니다. 계속 수신 중입니다.',
    no_claims_article: '이 페이지에서 검증 가능한 사실 주장을 찾지 못했습니다. 의견과 논평은 설계상 건너뜁니다.',
    check_failed: '확인 실패',
    try_again: '다시 시도',
    sources: (n) => `소스 (${n})`,
    no_sources: '소스가 가져오지 않았습니다',
    cached: '캐시됨',
  },
  zh: {
    ready: '就绪',
    nothing_checked: '尚未检查任何内容',
    nothing_checked_body: '从 Aletheia 工具栏菜单运行检查，以在此处查看陈述和判定。',
    service_unavailable: '服务不可用',
    service_unavailable_body: 'Aletheia 无法连接到其共享代理。请检查连接并重试。',
    no_claims: '没有可检查的陈述',
    no_claims_youtube: '此片段中没有可检查的新陈述。仍在监听中。',
    no_claims_article: '在此页面上未找到可验证的事实陈述。意见和评论按设计被跳过。',
    check_failed: '检查失败',
    try_again: '重试',
    sources: (n) => `来源 (${n})`,
    no_sources: '未检索到来源',
    cached: '已缓存',
  },
  ar: {
    ready: 'جاهز',
    nothing_checked: 'لم يتم فحص شيء بعد',
    nothing_checked_body: 'قم بتشغيل فحص من قائمة شريط أدوات Aletheia لرؤية المزاعم والأحكام هنا.',
    service_unavailable: 'الخدمة غير متاحة',
    service_unavailable_body: 'تعذر على Aletheia الوصول إلى البروكسي المشترك. تحقق من اتصالك وحاول مرة أخرى.',
    no_claims: 'لا توجد مزاعم للفحص',
    no_claims_youtube: 'لا توجد مزاعم جديدة قابلة للفحص في هذا المقطع. لا يزال الاستماع جارياً.',
    no_claims_article: 'لم يتم العثور على مزاعم واقعية قابلة للتحقق في هذه الصفحة. يتم تخطي الآراء والتعليقات بالتصميم.',
    check_failed: 'فشل الفحص',
    try_again: 'حاول مرة أخرى',
    sources: (n) => `المصادر (${n})`,
    no_sources: 'لم يتم استرجاع المصادر',
    cached: 'مؤقت',
  },
  es: {
    ready: 'Listo',
    nothing_checked: 'Nada verificado aún',
    nothing_checked_body: 'Ejecuta una verificación desde el menú de la barra de herramientas de Aletheia para ver las afirmaciones y veredictos aquí.',
    service_unavailable: 'Servicio no disponible',
    service_unavailable_body: 'Aletheia no pudo alcanzar su proxy compartido. Verifica tu conexión e intenta de nuevo.',
    no_claims: 'No hay afirmaciones para verificar',
    no_claims_youtube: 'No hay nuevas afirmaciones verificables en este segmento. Sigue escuchando.',
    no_claims_article: 'No se encontraron afirmaciones factuales verificables en esta página. Las opiniones y comentarios se omiten por diseño.',
    check_failed: 'Verificación fallida',
    try_again: 'Intentar de nuevo',
    sources: (n) => `Fuentes (${n})`,
    no_sources: 'No se obtuvieron fuentes',
    cached: 'en caché',
  },
  pt: {
    ready: 'Pronto',
    nothing_checked: 'Nada verificado ainda',
    nothing_checked_body: 'Execute uma verificação no menu da barra de ferramentas do Aletheia para ver alegações e veredictos aqui.',
    service_unavailable: 'Serviço indisponível',
    service_unavailable_body: 'O Aletheia não conseguiu alcançar seu proxy compartilhado. Verifique sua conexão e tente novamente.',
    no_claims: 'Não há alegações para verificar',
    no_claims_youtube: 'Não há novas alegações verificáveis neste segmento. Ainda ouvindo.',
    no_claims_article: 'Nenhuma alegação factual verificável foi encontrada nesta página. Opiniões e comentários são ignorados por design.',
    check_failed: 'Verificação falhou',
    try_again: 'Tentar novamente',
    sources: (n) => `Fontes (${n})`,
    no_sources: 'Nenhuma fonte obtida',
    cached: 'em cache',
  },
  jv: {
    ready: 'Siap',
    nothing_checked: 'Durung ana sing diperiksa',
    nothing_checked_body: 'Jalurake pemeriksaan saka menu toolbar Aletheia kanggo ndeleng klaim lan putusan ing kene.',
    service_unavailable: 'Layanan ora kasedhiya',
    service_unavailable_body: 'Aletheia ora bisa ngakses proksi bareng. Priksa koneksi sampeyan banjur coba maneh.',
    no_claims: 'Ora ana klaim kanggo diperiksa',
    no_claims_youtube: 'Ora ana klaim anyar sing bisa diperiksa ing segmen iki. Isih ngrungokake.',
    no_claims_article: 'Ora ditemokake klaim faktual sing bisa diverifikasi ing kaca iki. Opini lan komentar diwatesi dening desain.',
    check_failed: 'Pemeriksaan gagal',
    try_again: 'Coba maneh',
    sources: (n) => `Sumber (${n})`,
    no_sources: 'Ora ana sumber sing diduweni',
    cached: 'di-cache',
  },
  su: {
    ready: 'Siap',
    nothing_checked: 'Belum aya anu dicek',
    nothing_checked_body: 'Jalankeun panyodoran tina menu toolbar Aletheia pikeun ningali klaim sareng putusan di dieu.',
    service_unavailable: 'Layanan teu sayaga',
    service_unavailable_body: 'Aletheia teu tiasa ngahontal proksi babarengan. Pariksa sambungan anjeun teras coba deui.',
    no_claims: 'Teu aya klaim pikeun dicek',
    no_claims_youtube: 'Teu aya klaim anyar anu tiasa dicek dina segmen ieu. Masih ngadangu.',
    no_claims_article: 'Teu aya klaim fakta anu tiasa diverifikasi kapanggih dina kaca ieu. Opini sareng komentar diléwatan ku desain.',
    check_failed: 'Panyodoran gagal',
    try_again: 'Coba deui',
    sources: (n) => `Sumber (${n})`,
    no_sources: 'Teu aya sumber anu dikaluarkeun',
    cached: 'di-cache',
  },
};

let _overlayLang = 'id';
let _overlayStrings = OVERLAY_STRINGS.id;

function getOverlayString(key, ...args) {
  const val = _overlayStrings[key];
  if (typeof val === 'function') return val(...args);
  return val ?? key;
}

function setOverlayLang(lang) {
  _overlayLang = lang;
  _overlayStrings = OVERLAY_STRINGS[lang] || OVERLAY_STRINGS.id;
}

// Load language from storage
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
  chrome.storage.sync.get(['lang'], (data) => {
    setOverlayLang(data.lang || 'id');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.lang) setOverlayLang(changes.lang.newValue || 'id');
  });
}

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
          <span class="al-status" id="al-status" role="status" aria-live="polite" aria-atomic="true">${getOverlayString('ready')}</span>
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
        <div class="al-placeholder__title">${getOverlayString('nothing_checked')}</div>
        <div class="al-placeholder__body">${getOverlayString('nothing_checked_body')}</div>
      </div>
    `);
  }

  /** Hosted services are unavailable. */
  renderSetupState() {
    this._replaceFeed(`
      <div class="al-placeholder">
        <div class="al-placeholder__title">${getOverlayString('service_unavailable')}</div>
        <div class="al-placeholder__body">${getOverlayString('service_unavailable_body')}</div>
      </div>
    `);
    this.announce(getOverlayString('service_unavailable'));
  }

  renderNoClaims(mode) {
    const bodyKey = mode === 'youtube' ? 'no_claims_youtube' : 'no_claims_article';
    const body = getOverlayString(bodyKey);
    this._replaceFeed(`
      <div class="al-placeholder">
        <div class="al-placeholder__title">${getOverlayString('no_claims')}</div>
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
      : `<li class="al-sources__empty">${getOverlayString('no_sources')}</li>`;

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
          ${fromCache ? `<span class="al-chip">${getOverlayString('cached')}</span>` : ''}
        </div>
        <p class="al-claim">${this._esc(claim)}</p>
        <p class="al-explain">${this._esc(explanation)}</p>
        <button class="al-sources__toggle" type="button"
                aria-expanded="false" aria-controls="${sourcesId}">
          <span class="al-sources__arrow" aria-hidden="true"></span>${getOverlayString('sources', sources.length)}
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
        <div class="al-error__title">${getOverlayString('check_failed')}</div>
        <div class="al-error__body">${this._esc(message)}</div>
        ${onRetry ? `<button class="al-retry" type="button">${getOverlayString('try_again')}</button>` : ''}
      </div>
    `);
    if (onRetry) {
      this.claimsFeed.querySelector('.al-retry').addEventListener('click', () => onRetry());
    }
    this.announce(`${getOverlayString('check_failed')}. ${message}`);
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
