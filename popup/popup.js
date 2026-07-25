import { CONFIG } from '../config.js';

// === Elements ===
const nvidiaKeyInput = document.getElementById('nvidia-key');
const tavilyKeyInput = document.getElementById('tavily-key');
const deepgramKeyInput = document.getElementById('deepgram-key');
const themeToggle = document.getElementById('theme-toggle');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

function applyTheme(isLight) {
  if (isLight) {
    document.body.classList.add('light-theme');
    themeToggle.checked = true;
  } else {
    document.body.classList.remove('light-theme');
    themeToggle.checked = false;
  }
}

// === Load saved settings ===
chrome.storage.sync.get(
  ['nvidiaKey', 'tavilyKey', 'deepgramKey', 'theme'],
  (data) => {
    if (nvidiaKeyInput) {
      nvidiaKeyInput.value = data.nvidiaKey || CONFIG.NVIDIA_API_KEY || '';
    }
    if (data.tavilyKey && tavilyKeyInput) {
      tavilyKeyInput.value = data.tavilyKey;
    }
    if (data.deepgramKey && deepgramKeyInput) {
      deepgramKeyInput.value = data.deepgramKey;
    }
    applyTheme(data.theme === 'light');
  }
);

// === Theme toggle listener ===
themeToggle.addEventListener('change', () => {
  const isLight = themeToggle.checked;
  applyTheme(isLight);
  chrome.storage.sync.set({ theme: isLight ? 'light' : 'dark' });
});

// === Save settings ===
saveBtn.addEventListener('click', () => {
  const settings = {
    nvidiaKey: nvidiaKeyInput ? nvidiaKeyInput.value.trim() : (CONFIG.NVIDIA_API_KEY || ''),
    tavilyKey: tavilyKeyInput.value.trim(),
    deepgramKey: deepgramKeyInput.value.trim(),
    theme: themeToggle.checked ? 'light' : 'dark',
  };

  chrome.storage.sync.set(settings, () => {
    saveStatus.textContent = 'SAVED';
    saveStatus.classList.add('visible');
    setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 2000);
  });
});

// === YouTube Active Tab Trigger ===
const startYoutubeBtn = document.getElementById('start-youtube-btn');

if (startYoutubeBtn) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
      startYoutubeBtn.style.display = 'inline-block';
    } else {
      startYoutubeBtn.style.display = 'none';
    }
  });

  startYoutubeBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id || !tab.url?.includes('youtube.com')) {
      alert('Buka video YouTube terlebih dahulu!');
      return;
    }

    chrome.runtime.sendMessage({
      type: 'START_YOUTUBE',
      tabId: tab.id,
    });

    startYoutubeBtn.textContent = 'STARTED';
    setTimeout(() => {
      startYoutubeBtn.textContent = 'Start Fact-Check';
    }, 2000);
  });
}
