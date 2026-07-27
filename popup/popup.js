import { CONFIG } from '../config.js';

// === Elements ===
const themeToggle = document.getElementById('theme-toggle');
const startFactCheckBtn = document.getElementById('start-fact-check-btn');
const modeTitle = document.getElementById('mode-title');
const modeDescription = document.getElementById('mode-description');
const modeHint = document.getElementById('mode-hint');
const actionStatus = document.getElementById('action-status');
const connectionStatus = document.getElementById('connection-status');
const connectionTitle = document.getElementById('connection-title');
const connectionDetail = document.getElementById('connection-detail');
let activeTab = null;
let activeMode = 'unsupported';

function applyTheme(isLight) {
  if (isLight) {
    document.body.classList.add('light-theme');
    themeToggle.checked = true;
  } else {
    document.body.classList.remove('light-theme');
    themeToggle.checked = false;
  }
}

chrome.storage.sync.get(['theme'], (data) => applyTheme(data.theme === 'light'));

// The overlay live-syncs theme via storage.onChanged; without this the popup
// only picked up the theme on load, so the two surfaces could disagree.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.theme) applyTheme(changes.theme.newValue === 'light');
  });
}

// === Theme toggle listener ===
themeToggle.addEventListener('change', () => {
  const isLight = themeToggle.checked;
  applyTheme(isLight);
  chrome.storage.sync.set({ theme: isLight ? 'light' : 'dark' });
});

// === Active Tab Fact-Check Trigger ===
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

/**
 * Show a transient message in the status line.
 */
function showNotice(text, ms = 3200) {
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

  if (activeMode === 'youtube-live') {
    modeTitle.textContent = 'YouTube live check';
    modeDescription.textContent = 'Aletheia listens to the playing video and checks spoken claims as they arrive.';
    modeHint.textContent = 'Play the video with sound before you start. Keep this tab open while Aletheia listens.';
    startFactCheckBtn.textContent = 'Listen to live video';
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'youtube-recorded') {
    modeTitle.textContent = 'YouTube video check';
    modeDescription.textContent = 'Aletheia listens with Gemini and checks spoken claims as the video plays.';
    modeHint.textContent = 'Play the video with sound before you start. You can pause when you want Aletheia to stop hearing new claims.';
    startFactCheckBtn.textContent = 'Listen to this video';
    startFactCheckBtn.disabled = false;
    return;
  }

  if (activeMode === 'article') {
    modeTitle.textContent = 'Article check';
    modeDescription.textContent = 'Aletheia reads the current page, finds factual claims, and checks supporting sources.';
    modeHint.textContent = 'Results appear in a panel on the current page.';
    startFactCheckBtn.textContent = 'Check this page';
    startFactCheckBtn.disabled = false;
    return;
  }

  modeTitle.textContent = 'Open something to check';
  modeDescription.textContent = 'Switch to a web article or a YouTube video, then open Aletheia again.';
  modeHint.textContent = 'Browser settings and internal pages cannot be fact-checked.';
  startFactCheckBtn.textContent = 'No supported page';
  startFactCheckBtn.disabled = true;
}

chrome.tabs.query({ active: true, currentWindow: true })
  .then(async ([tab]) => renderMode(tab, await detectMode(tab)))
  .catch(() => renderMode(null, 'unsupported'));

fetch(`${CONFIG.PROXY_URL}/health`)
  .then((response) => {
    if (!response.ok) throw new Error('Proxy unavailable');
    connectionTitle.textContent = 'Secure proxy connected';
    connectionDetail.textContent = 'Gemini and Tavily are ready. No setup needed.';
  })
  .catch(() => {
    connectionStatus.classList.add('is-offline');
    connectionTitle.textContent = 'Proxy unavailable';
    connectionDetail.textContent = 'Check your connection, then reopen Aletheia.';
  });

startFactCheckBtn.addEventListener('click', async () => {
  if (!activeTab?.id || activeMode === 'unsupported') return;

  startFactCheckBtn.disabled = true;
  startFactCheckBtn.textContent = activeMode === 'youtube-live'
    ? 'Starting listener…'
    : activeMode === 'youtube-recorded'
      ? 'Starting listener…'
      : 'Starting check…';

  if (activeMode.startsWith('youtube-')) {
    await chrome.runtime.sendMessage({
      type: 'START_YOUTUBE',
      tabId: activeTab.id,
    });
  } else {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'START_ARTICLE_CHECK' }).catch(() => {
      showNotice('Reload this page, then try again.');
    });
  }

  startFactCheckBtn.textContent = 'Started';
  showNotice('The fact-check panel is opening on this tab.');
  setTimeout(() => renderMode(activeTab, activeMode), 1800);
});
