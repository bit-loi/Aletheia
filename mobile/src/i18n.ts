/**
 * i18n.ts: Lightweight internationalization module for Aletheia Mobile.
 *
 * Provides a t() function for translating UI strings across 10 languages.
 * Uses static imports for translation JSON files (React Native compatible).
 *
 * Supported languages: id, en, ja, ko, zh, ar, es, pt, jv, su
 */

import id from '../../shared/locales/id.json';
import en from '../../shared/locales/en.json';
import ja from '../../shared/locales/ja.json';
import ko from '../../shared/locales/ko.json';
import zh from '../../shared/locales/zh.json';
import ar from '../../shared/locales/ar.json';
import es from '../../shared/locales/es.json';
import pt from '../../shared/locales/pt.json';
import jv from '../../shared/locales/jv.json';
import su from '../../shared/locales/su.json';

const LOCALES: Record<string, Record<string, string>> = {
  id, en, ja, ko, zh, ar, es, pt, jv, su,
};

export type LangCode = 'id' | 'en' | 'ja' | 'ko' | 'zh' | 'ar' | 'es' | 'pt' | 'jv' | 'su';

export const SUPPORTED_LANGS: LangCode[] = ['id', 'en', 'ja', 'ko', 'zh', 'ar', 'es', 'pt', 'jv', 'su'];
export const DEFAULT_LANG: LangCode = 'id';

export const LANG_LABELS: Record<LangCode, string> = {
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

export const LANG_NAMES: Record<LangCode, string> = {
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
 * Get a translated string by key, with optional parameter interpolation.
 *
 * @param key - Translation key (e.g., 'checking_claim')
 * @param params - Parameters to interpolate
 *   e.g., t('checking_claim', { current: 1, total: 3 }) → "Memeriksa klaim 1 dari 3…"
 * @param lang - Current language code
 * @returns Translated string, or the key itself if not found
 */
export function t(key: string, lang: LangCode = DEFAULT_LANG, params: Record<string, string | number> = {}): string {
  const locale = LOCALES[lang] || LOCALES[DEFAULT_LANG];
  let str = locale[key] ?? key;

  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }

  return str;
}

/**
 * Check if a language uses RTL layout.
 */
export function isRTL(lang: LangCode): boolean {
  return lang === 'ar';
}

/**
 * Language type guard.
 */
export function isValidLang(lang: string): lang is LangCode {
  return SUPPORTED_LANGS.includes(lang as LangCode);
}
