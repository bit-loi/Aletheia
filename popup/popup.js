// === Elements ===
const openrouterKeyInput = document.getElementById('openrouter-key');
const tavilyKeyInput = document.getElementById('tavily-key');
const deepgramKeyInput = document.getElementById('deepgram-key');
const modelSelect = document.getElementById('model-select');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

const statusDots = {
  openrouter: document.getElementById('openrouter-status'),
  tavily: document.getElementById('tavily-status'),
  deepgram: document.getElementById('deepgram-status'),
};

// === Load saved settings ===
chrome.storage.sync.get(
  ['openrouterKey', 'tavilyKey', 'deepgramKey', 'model'],
  (data) => {
    if (data.openrouterKey) {
      openrouterKeyInput.value = data.openrouterKey;
      statusDots.openrouter.classList.add('set');
    }
    if (data.tavilyKey) {
      tavilyKeyInput.value = data.tavilyKey;
      statusDots.tavily.classList.add('set');
    }
    if (data.deepgramKey) {
      deepgramKeyInput.value = data.deepgramKey;
      statusDots.deepgram.classList.add('set');
    }
    if (data.model) {
      modelSelect.value = data.model;
    }
  }
);

// === Save settings ===
saveBtn.addEventListener('click', () => {
  const settings = {
    openrouterKey: openrouterKeyInput.value.trim(),
    tavilyKey: tavilyKeyInput.value.trim(),
    deepgramKey: deepgramKeyInput.value.trim(),
    model: modelSelect.value,
  };

  chrome.storage.sync.set(settings, () => {
    // Update status dots
    statusDots.openrouter.classList.toggle('set', !!settings.openrouterKey);
    statusDots.tavily.classList.toggle('set', !!settings.tavilyKey);
    statusDots.deepgram.classList.toggle('set', !!settings.deepgramKey);

    // Flash confirmation
    saveStatus.textContent = '✓ Saved';
    saveStatus.classList.add('visible');
    setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 2000);
  });
});
