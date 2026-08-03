import { CONFIG } from '../config.js';
import { t, loadLang, getLang, saveLangToStorage, LANG_LABELS, LANG_NAMES, getSupportedLangs } from '../shared/i18n.js';

// === Elements ===
const themeToggle = document.getElementById('theme-toggle');
const langDropdown = document.getElementById('lang-dropdown');
const langTrigger = document.getElementById('lang-trigger');
const langCurrent = document.getElementById('lang-current');
const langMenu = document.getElementById('lang-menu');
const startFactCheckBtn = document.getElementById('start-fact-check-btn');
const modeCardLabel = document.getElementById('mode-card-label');
const modeTitle = document.getElementById('mode-title');
const modeDescription = document.getElementById('mode-description');
const modeHint = document.getElementById('mode-hint');
const actionStatus = document.getElementById('action-status');
const connectionStatus = document.getElementById('connection-status');
const connectionTitle = document.getElementById('connection-title');
const connectionDetail = document.getElementById('connection-detail');

let activeTab = null;
let activeMode = 'unsupported';
let currentLang = 'id';
let proxyOk = true;
let isMenuOpen = false;

// === Language Dropdown ===

function buildLangMenu() {
  if (!langMenu) return;
  const langs = getSupportedLangs();
  langMenu.innerHTML = '';

  langs.forEach((lang) => {
    const item = document.createElement('button');
    item.className = 'lang-dropdown__item';
    item.type = 'button';
    item.role = 'option';
    item.dataset.lang = lang;
    item.setAttribute('aria-selected', lang === currentLang ? 'true' : 'false');

    if (lang === currentLang) {
      item.classList.add('is-active');
    }

    item.innerHTML = `
      <span>${LANG_LABELS[lang]}</span>
      <span class="lang-dropdown__item-name">${LANG_NAMES[lang]}</span>
    `;

    item.addEventListener('click', () => {
      selectLang(lang);
      closeMenu();
    });

    langMenu.appendChild(item);
  });
}

function selectLang(lang) {
  currentLang = lang;
  applyLang(lang);
  saveLangToStorage(lang);
}

function openMenu() {
  if (!langMenu || !langTrigger) return;
  isMenuOpen = true;
  langMenu.classList.add('is-open');
  langTrigger.classList.add('is-open');
  langTrigger.setAttribute('aria-expanded', 'true');

  // Update active state
  const items = langMenu.querySelectorAll('.lang-dropdown__item');
  items.forEach((item) => {
    const isActive = item.dataset.lang === currentLang;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Scroll active item into view
  const activeItem = langMenu.querySelector('.lang-dropdown__item.is-active');
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
  }
}

function closeMenu() {
  if (!langMenu || !langTrigger) return;
  isMenuOpen = false;
  langMenu.classList.remove('is-open');
  langTrigger.classList.remove('is-open');
  langTrigger.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
  if (isMenuOpen) {
    closeMenu();
  } else {
    openMenu();
  }
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (langDropdown && !langDropdown.contains(e.target)) {
    closeMenu();
  }
});

// Keyboard navigation
if (langTrigger) {
  langTrigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMenu();
    } else if (e.key === 'Escape') {
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
      const firstItem = langMenu?.querySelector('.lang-dropdown__item');
      firstItem?.focus();
    }
  });
}

if (langMenu) {
  langMenu.addEventListener('keydown', (e) => {
    const items = Array.from(langMenu.querySelectorAll('.lang-dropdown__item'));
    const currentIndex = items.indexOf(document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[currentIndex + 1];
      if (next) next.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[currentIndex - 1];
      if (prev) prev.focus();
    } else if (e.key === 'Escape') {
      closeMenu();
      langTrigger?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const focused = document.activeElement;
      if (focused?.classList.contains('lang-dropdown__item')) {
        focused.click();
      }
    }
  });
}

// === Core Functions ===

function applyTheme(isLight) {
  if (isLight) {
    document.body.classList.add('light-theme');
    if (themeToggle) themeToggle.checked = true;
  } else {
    document.body.classList.remove('light-theme');
    if (themeToggle) themeToggle.checked = false;
  }
}

function updateAllUiStrings() {
  if (modeCardLabel) {
    modeCardLabel.textContent = t('current_page');
  }

  if (connectionTitle && connectionDetail) {
    if (!proxyOk) {
      connectionStatus?.classList.add('is-offline');
      connectionTitle.textContent = t('proxy_unavailable');
      connectionDetail.textContent = t('proxy_unavailable_detail');
    } else {
      connectionStatus?.classList.remove('is-offline');
      connectionTitle.textContent = t('proxy_connected');
      connectionDetail.textContent = t('proxy_connected_detail');
    }
  }

  if (activeTab) {
    renderMode(activeTab, activeMode);
  }
}

async function applyLang(lang) {
  currentLang = lang;
  await loadLang(lang);

  // Update trigger label
  if (langCurrent) {
    langCurrent.textContent = LANG_LABELS[lang] || lang.toUpperCase();
  }

  // Rebuild menu to update active states
  buildLangMenu();

  updateAllUiStrings();
}

// Initialize i18n from storage
chrome.storage.sync.get(['theme', 'lang'], async (data) => {
  applyTheme(data.theme === 'light');
  await applyLang(data.lang || 'id');
  buildLangMenu();
});

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.theme) applyTheme(changes.theme.newValue === 'light');
      if (changes.lang) applyLang(changes.lang.newValue || 'id');
    }
  });
}

if (themeToggle) {
  themeToggle.addEventListener('change', () => {
    const isLight = themeToggle.checked;
    applyTheme(isLight);
    chrome.storage.sync.set({ theme: isLight ? 'light' : 'dark' });
  });
}

if (langTrigger) {
  langTrigger.addEventListener('click', toggleMenu);
}

function isYouTubeVideo(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.length > 1;
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return false;
    return url.pathname === '/watch' ||
      url.pathname.startsWith('/live/') ||
      url.pathname.startsWith('/shorts/');
  } catch (_) {
    return false;
  }
}

function showNotice(text, ms = 3200) {
  if (!actionStatus) return;
  actionStatus.textContent = text;
  actionStatus.classList.add('visible');
  setTimeout(() => actionStatus.classList.remove('visible'), ms);
}

async function detectMode(tab) {
  if (!tab?.id || !tab?.url?.startsWith('http')) return 'unsupported';
  if (!isYouTubeVideo(tab.url)) return 'article';

  const url = new URL(tab.url);
  if (url.pathname.startsWith('/live/')) return 'youtube-live';

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const video = document.querySelector('video');
        const liveBadge = document.querySelector('.ytp-live-badge');
        return Boolean(
          (video && !Number.isFinite(video.duration)) ||
          (liveBadge && liveBadge.getClientRects().length > 0)
        );
      },
    });
    return result ? 'youtube-live' : 'youtube-recorded';
  } catch (_) {
    return 'youtube-recorded';
  }
}

function renderMode(tab, mode) {
  activeTab = tab;
  activeMode = mode;

  if (!modeTitle || !modeDescription || !modeHint || !startFactCheckBtn) return;

  if (activeMode === 'youtube-live') {
    modeTitle.textContent = t('youtube_live_verification');
    modeDescription.textContent = t('youtube_live_desc');
    modeHint.textContent = t('youtube_live_hint');
    startFactCheckBtn.textContent = t('listen_live_video');
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'youtube-recorded') {
    modeTitle.textContent = t('youtube_video_verification');
    modeDescription.textContent = t('youtube_recorded_desc');
    modeHint.textContent = t('youtube_recorded_hint');
    startFactCheckBtn.textContent = t('listen_video');
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'article') {
    modeTitle.textContent = t('article_verification');
    modeDescription.textContent = t('article_desc');
    modeHint.textContent = t('article_hint');
    startFactCheckBtn.textContent = t('check_page');
    startFactCheckBtn.disabled = false;
    return;
  }

  modeTitle.textContent = t('open_content');
  modeDescription.textContent = t('open_content_desc');
  modeHint.textContent = t('unsupported_hint');
  startFactCheckBtn.textContent = t('unsupported_page');
  startFactCheckBtn.disabled = true;
}

chrome.tabs.query({ active: true, currentWindow: true })
  .then(async ([tab]) => renderMode(tab, await detectMode(tab)))
  .catch(() => renderMode(null, 'unsupported'));

fetch(`${CONFIG.PROXY_URL}/health`)
  .then((response) => {
    proxyOk = response.ok;
    updateAllUiStrings();
  })
  .catch(() => {
    proxyOk = false;
    updateAllUiStrings();
  });

if (startFactCheckBtn) {
  startFactCheckBtn.addEventListener('click', async () => {
    if (!activeTab?.id || activeMode === 'unsupported') return;

    startFactCheckBtn.disabled = true;
    startFactCheckBtn.textContent = t('starting_listener');

    if (activeMode.startsWith('youtube-')) {
      await chrome.runtime.sendMessage({
        type: 'START_YOUTUBE',
        tabId: activeTab.id,
        lang: currentLang,
      });
    } else {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_ARTICLE_CHECK', lang: currentLang }).catch(() => {
        showNotice(t('reload_page'));
      });
    }

    startFactCheckBtn.textContent = t('started');
    showNotice(t('fact_check_opening'));
    setTimeout(() => renderMode(activeTab, activeMode), 1800);
  });
}
