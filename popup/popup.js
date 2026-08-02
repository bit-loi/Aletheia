import { CONFIG } from '../config.js';

// === Elements ===
const themeToggle = document.getElementById('theme-toggle');
const langBtnId = document.getElementById('lang-btn-id');
const langBtnEn = document.getElementById('lang-btn-en');
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
  const isEn = currentLang === 'en';

  if (modeCardLabel) {
    modeCardLabel.textContent = isEn ? 'Current Page' : 'Halaman saat ini';
  }

  if (connectionTitle && connectionDetail) {
    if (!proxyOk) {
      connectionStatus?.classList.add('is-offline');
      connectionTitle.textContent = isEn ? 'Proxy Unavailable' : 'Proxy tidak tersedia';
      connectionDetail.textContent = isEn ? 'Check network connection, then launch Aletheia again.' : 'Periksa koneksi Anda, lalu buka Aletheia kembali.';
    } else {
      connectionStatus?.classList.remove('is-offline');
      connectionTitle.textContent = isEn ? 'Secure Proxy Connected' : 'Proxy aman terhubung';
      connectionDetail.textContent = isEn ? 'Gemini and search services ready.' : 'Gemini dan Tavily siap digunakan.';
    }
  }

  if (activeTab) {
    renderMode(activeTab, activeMode);
  }
}

function applyLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'id';
  if (langBtnId && langBtnEn) {
    if (currentLang === 'en') {
      langBtnEn.classList.add('active');
      langBtnId.classList.remove('active');
    } else {
      langBtnId.classList.add('active');
      langBtnEn.classList.remove('active');
    }
  }
  updateAllUiStrings();
}

chrome.storage.sync.get(['theme', 'lang'], (data) => {
  applyTheme(data.theme === 'light');
  applyLang(data.lang || 'id');
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

if (langBtnId) {
  langBtnId.addEventListener('click', () => {
    applyLang('id');
    chrome.storage.sync.set({ lang: 'id' });
  });
}

if (langBtnEn) {
  langBtnEn.addEventListener('click', () => {
    applyLang('en');
    chrome.storage.sync.set({ lang: 'en' });
  });
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
  const isEn = currentLang === 'en';

  if (!modeTitle || !modeDescription || !modeHint || !startFactCheckBtn) return;

  if (activeMode === 'youtube-live') {
    modeTitle.textContent = isEn ? 'YouTube Live Verification' : 'Verifikasi YouTube Live';
    modeDescription.textContent = isEn ? 'Aletheia listens to live video broadcast and verifies spoken claims in real time.' : 'Aletheia mendengarkan siaran video dan memeriksa klaim ucapan secara langsung.';
    modeHint.textContent = isEn ? 'Ensure video audio is playing through speakers before starting.' : 'Putar video dengan suara sebelum memulai. Biarkan tab ini terbuka saat Aletheia mendengarkan.';
    startFactCheckBtn.textContent = isEn ? 'Listen to live video' : 'Dengarkan video live';
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'youtube-recorded') {
    modeTitle.textContent = isEn ? 'YouTube Video Verification' : 'Verifikasi Video YouTube';
    modeDescription.textContent = isEn ? 'Aletheia listens alongside Gemini and verifies claims as the video plays.' : 'Aletheia mendengarkan bersama Gemini dan memeriksa klaim ucapan saat video diputar.';
    modeHint.textContent = isEn ? 'Ensure video audio is playing through speakers before starting.' : 'Putar video dengan suara sebelum memulai. Anda dapat menjeda video untuk menghentikan klaim baru.';
    startFactCheckBtn.textContent = isEn ? 'Listen to this video' : 'Dengarkan video ini';
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'article') {
    modeTitle.textContent = isEn ? 'Article Verification' : 'Verifikasi Artikel';
    modeDescription.textContent = isEn ? 'Aletheia scans the current page, extracts factual claims, and checks sources.' : 'Aletheia membaca halaman saat ini, menemukan klaim faktual, dan memeriksa sumber pendukung.';
    modeHint.textContent = isEn ? 'Results will appear on the floating overlay card.' : 'Hasil akan muncul pada panel melayang di halaman ini.';
    startFactCheckBtn.textContent = isEn ? 'Check this page' : 'Periksa halaman ini';
    startFactCheckBtn.disabled = false;
    return;
  }

  modeTitle.textContent = isEn ? 'Open content to check' : 'Buka konten untuk diperiksa';
  modeDescription.textContent = isEn ? 'Open a news article or YouTube video, then open Aletheia again.' : 'Buka artikel web atau video YouTube, lalu buka Aletheia kembali.';
  modeHint.textContent = isEn ? 'Browser settings and internal pages cannot be checked.' : 'Pengaturan browser dan halaman internal tidak dapat diperiksa.';
  startFactCheckBtn.textContent = isEn ? 'Unsupported page' : 'Halaman tidak didukung';
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

    const isEn = currentLang === 'en';
    startFactCheckBtn.disabled = true;
    startFactCheckBtn.textContent = isEn ? 'Starting listener…' : 'Memulai pendengar…';

    if (activeMode.startsWith('youtube-')) {
      await chrome.runtime.sendMessage({
        type: 'START_YOUTUBE',
        tabId: activeTab.id,
        lang: currentLang,
      });
    } else {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_ARTICLE_CHECK', lang: currentLang }).catch(() => {
        showNotice(isEn ? 'Reload this page, then try again.' : 'Muat ulang halaman ini, lalu coba lagi.');
      });
    }

    startFactCheckBtn.textContent = isEn ? 'Started' : 'Dimulai';
    showNotice(isEn ? 'Fact check overlay is opening on this tab.' : 'Panel verifikasi sedang dibuka pada tab ini.');
    setTimeout(() => renderMode(activeTab, activeMode), 1800);
  });
}
