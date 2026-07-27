import { CONFIG } from '../config.js';

// === Elements ===
const llmKeyInput = document.getElementById('llm-key');
const tavilyKeyInput = document.getElementById('tavily-key');
const deepgramKeyInput = document.getElementById('deepgram-key');
const themeToggle = document.getElementById('theme-toggle');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const firstRun = document.getElementById('first-run');

/**
 * Show the "Ready to use" note while the user has no personal keys, i.e. while
 * they are on the shared proxy quota. Keys are optional, so this is
 * informational, not a setup gate.
 */
function updateFirstRun(llmKey, tavilyKey) {
  if (firstRun) firstRun.classList.toggle('is-visible', !(llmKey && tavilyKey));
}

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
  ['llmKey', 'nvidiaKey', 'tavilyKey', 'deepgramKey', 'theme'],
  (data) => {
    if (llmKeyInput) {
      // `nvidiaKey` is the legacy name; read it so an already-saved key is not
      // silently lost after the switch to Gemini.
      llmKeyInput.value = data.llmKey || data.nvidiaKey || CONFIG.LLM_API_KEY || '';
    }
    if (data.tavilyKey && tavilyKeyInput) {
      tavilyKeyInput.value = data.tavilyKey;
    }
    if (data.deepgramKey && deepgramKeyInput) {
      deepgramKeyInput.value = data.deepgramKey;
    }
    applyTheme(data.theme === 'light');
    updateFirstRun(data.llmKey || data.nvidiaKey, data.tavilyKey);
  }
);

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

// === Save settings ===
saveBtn.addEventListener('click', () => {
  const settings = {
    llmKey: llmKeyInput ? llmKeyInput.value.trim() : (CONFIG.LLM_API_KEY || ''),
    tavilyKey: tavilyKeyInput.value.trim(),
    deepgramKey: deepgramKeyInput.value.trim(),
    theme: themeToggle.checked ? 'light' : 'dark',
  };

  chrome.storage.sync.set(settings, () => {
    updateFirstRun(settings.llmKey, settings.tavilyKey);
    saveStatus.textContent = 'SAVED';
    saveStatus.classList.add('visible');
    setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 2000);
  });
});

// === Active Tab Fact-Check Trigger ===
const startFactCheckBtn = document.getElementById('start-youtube-btn');

/**
 * Show a transient message in the status line.
 *
 * Used instead of alert(), which can dismiss the popup entirely on some
 * platforms and would take the user's context with it.
 */
function showNotice(text, ms = 3200) {
  saveStatus.textContent = text;
  saveStatus.classList.add('visible');
  setTimeout(() => saveStatus.classList.remove('visible'), ms);
}

if (startFactCheckBtn) {
  startFactCheckBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id || !tab.url || !tab.url.startsWith('http')) {
      showNotice('Open a news article or YouTube video first.');
      return;
    }

    if (tab.url.includes('youtube.com/watch')) {
      chrome.runtime.sendMessage({
        type: 'START_YOUTUBE',
        tabId: tab.id,
      });
    } else {
      chrome.tabs.sendMessage(tab.id, { type: 'START_ARTICLE_CHECK' }).catch(() => {
        showNotice('Reload this page to start fact-checking.');
      });
    }

    startFactCheckBtn.textContent = 'STARTED';
    setTimeout(() => {
      startFactCheckBtn.textContent = 'Start Fact-Check';
    }, 2000);
  });
}
