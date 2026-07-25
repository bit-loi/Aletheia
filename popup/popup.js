// === Elements ===
const geminiKeyInput = document.getElementById('gemini-key');
const openrouterKeyInput = document.getElementById('openrouter-key');
const tavilyKeyInput = document.getElementById('tavily-key');
const deepgramKeyInput = document.getElementById('deepgram-key');
const modelSelect = document.getElementById('model-select');
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

// === Custom Dropdown Logic ===
const customDropdown = document.getElementById('custom-model-dropdown');
const dropdownTrigger = document.getElementById('dropdown-trigger');
const dropdownMenu = document.getElementById('dropdown-menu');
const selectedModelText = document.getElementById('selected-model-text');

function setCustomDropdownValue(value) {
  modelSelect.value = value;
  const items = dropdownMenu.querySelectorAll('.dropdown-item');
  let found = false;
  items.forEach((item) => {
    if (item.dataset.value === value) {
      item.classList.add('selected');
      found = true;
      const itemLabel = item.querySelector('span:first-child')?.textContent || item.textContent;
      selectedModelText.textContent = itemLabel;
    } else {
      item.classList.remove('selected');
    }
  });
  if (!found && items.length > 0) {
    items[0].classList.add('selected');
    modelSelect.value = items[0].dataset.value;
    selectedModelText.textContent = items[0].querySelector('span:first-child')?.textContent || items[0].textContent;
  }
}

if (dropdownTrigger && dropdownMenu) {
  dropdownTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    customDropdown.classList.toggle('open');
  });

  dropdownMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    const value = item.dataset.value;
    setCustomDropdownValue(value);
    customDropdown.classList.remove('open');
  });

  document.addEventListener('click', () => {
    customDropdown.classList.remove('open');
  });
}

// === Load saved settings ===
chrome.storage.sync.get(
  ['geminiKey', 'openrouterKey', 'tavilyKey', 'deepgramKey', 'model', 'theme'],
  (data) => {
    if (data.geminiKey && geminiKeyInput) {
      geminiKeyInput.value = data.geminiKey;
    }
    if (data.openrouterKey && openrouterKeyInput) {
      openrouterKeyInput.value = data.openrouterKey;
    }
    if (data.tavilyKey && tavilyKeyInput) {
      tavilyKeyInput.value = data.tavilyKey;
    }
    if (data.deepgramKey && deepgramKeyInput) {
      deepgramKeyInput.value = data.deepgramKey;
    }
    if (data.model) {
      setCustomDropdownValue(data.model);
    } else {
      setCustomDropdownValue('google/gemma-4-31b-it:free');
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
    geminiKey: geminiKeyInput ? geminiKeyInput.value.trim() : '',
    openrouterKey: openrouterKeyInput.value.trim(),
    tavilyKey: tavilyKeyInput.value.trim(),
    deepgramKey: deepgramKeyInput.value.trim(),
    model: modelSelect.value,
    theme: themeToggle.checked ? 'light' : 'dark',
  };

  chrome.storage.sync.set(settings, () => {
    // Flash confirmation
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

    // Send trigger to Service Worker
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
