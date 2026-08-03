/**
 * i18n.js: Lightweight internationalization module for Aletheia.
 *
 * Provides a t() function for translating UI strings across 10 languages.
 * Works in both Chrome extension and React Native mobile contexts.
 *
 * Supported languages: id, en, ja, ko, zh, ar, es, pt, jv, su
 */

const SUPPORTED_LANGS = ['id', 'en', 'ja', 'ko', 'zh', 'ar', 'es', 'pt', 'jv', 'su'];
const DEFAULT_LANG = 'id';

let currentLang = DEFAULT_LANG;
let translations = {};
let onLangChangeCallbacks = [];

/**
 * Load translations for a given language.
 * @param {string} lang - Language code
 * @returns {Promise<void>}
 */
export async function loadLang(lang) {
  const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
  currentLang = safeLang;

  try {
    let url;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      // Chrome extension context
      url = chrome.runtime.getURL(`shared/locales/${safeLang}.json`);
    } else {
      // Fallback for testing or other contexts
      url = `./locales/${safeLang}.json`;
    }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load locale: ${safeLang}`);
    translations = await resp.json();
  } catch (err) {
    console.warn(`[Aletheia i18n] Failed to load ${safeLang}:`, err.message);
    // Fallback to default if not already
    if (safeLang !== DEFAULT_LANG) {
      return loadLang(DEFAULT_LANG);
    }
    translations = {};
  }

  // Notify listeners
  onLangChangeCallbacks.forEach((cb) => {
    try { cb(safeLang); } catch (_) {}
  });
}

/**
 * Get a translated string by key, with optional parameter interpolation.
 *
 * @param {string} key - Translation key (e.g., 'checking_claim')
 * @param {Object<string, string|number>} [params={}] - Parameters to interpolate
 *   e.g., t('checking_claim', { current: 1, total: 3 }) → "Memeriksa klaim 1 dari 3…"
 * @returns {string} Translated string, or the key itself if not found
 */
export function t(key, params = {}) {
  let str = translations[key] ?? key;

  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }

  return str;
}

/**
 * Get the current language code.
 * @returns {string}
 */
export function getLang() {
  return currentLang;
}

/**
 * Check if the current language uses RTL layout.
 * @returns {boolean}
 */
export function isRTL() {
  return currentLang === 'ar';
}

/**
 * Register a callback for language changes.
 * @param {function(string): void} callback
 * @returns {function(): void} Unsubscribe function
 */
export function onLangChange(callback) {
  onLangChangeCallbacks.push(callback);
  return () => {
    onLangChangeCallbacks = onLangChangeCallbacks.filter((cb) => cb !== callback);
  };
}

/**
 * Get the list of supported language codes.
 * @returns {string[]}
 */
export function getSupportedLangs() {
  return [...SUPPORTED_LANGS];
}

/**
 * Language display names for the UI selector.
 */
export const LANG_LABELS = {
  id: 'ID',
  en: 'EN',
  ja: 'JA',
  ko: 'KO',
  zh: 'ZH',
  ar: 'AR',
  es: 'ES',
  pt: 'PT',
  jv: 'JV',
  su: 'SU',
};

/**
 * Full language names (for accessibility).
 */
export const LANG_NAMES = {
  id: 'Bahasa Indonesia',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  ar: 'العربية',
  es: 'Español',
  pt: 'Português',
  jv: 'Jawa',
  su: 'Sunda',
};

/**
 * Initialize i18n from Chrome storage (extension context).
 * @returns {Promise<string>} The loaded language code
 */
export async function initFromStorage() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['lang'], async (data) => {
        const lang = data.lang || DEFAULT_LANG;
        await loadLang(lang);
        resolve(lang);
      });
    } else {
      loadLang(DEFAULT_LANG);
      resolve(DEFAULT_LANG);
    }
  });
}

/**
 * Save language to Chrome storage (extension context).
 * @param {string} lang
 */
export function saveLangToStorage(lang) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.set({ lang });
  }
}
