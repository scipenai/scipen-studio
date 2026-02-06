/**
 * @file index.ts - Internationalization system
 * @description Provides multi-language support, manages language switching and translation for English, Chinese, and other languages
 */

import { useMemo, useSyncExternalStore } from 'react';
import enUS from './en-US.json';
import zhCN from './zh-CN.json';

export type LocaleKey = 'en-US' | 'zh-CN';

export interface LocaleInfo {
  key: LocaleKey;
  name: string;
  nativeName: string;
}

export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { key: 'en-US', name: 'English', nativeName: 'English' },
  { key: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
];

const translations: Record<LocaleKey, typeof enUS> = {
  'en-US': enUS,
  'zh-CN': zhCN,
};

let currentLocale: LocaleKey = 'zh-CN';

// Subscriber list - used to notify React components of language changes
type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LocaleKey {
  return currentLocale;
}

/**
 * Get the current locale
 */
export function getLocale(): LocaleKey {
  return currentLocale;
}

/**
 * Set the current locale
 */
export function setLocale(locale: LocaleKey): void {
  if (translations[locale]) {
    if (currentLocale !== locale) {
      currentLocale = locale;
      emitChange(); // Notify all subscribers
    }
  } else {
    console.warn(`Locale "${locale}" not found, falling back to en-US`);
    if (currentLocale !== 'en-US') {
      currentLocale = 'en-US';
      emitChange();
    }
  }
}

/**
 * Detect and set locale from browser/system
 */
export function detectLocale(): LocaleKey {
  const browserLang = navigator.language;

  // Check exact match first
  if (browserLang in translations) {
    return browserLang as LocaleKey;
  }

  // Check prefix match (e.g., 'zh' -> 'zh-CN')
  const prefix = browserLang.split('-')[0];
  for (const key of Object.keys(translations) as LocaleKey[]) {
    if (key.startsWith(prefix)) {
      return key;
    }
  }

  return 'en-US';
}

type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? `${K}.${NestedKeyOf<T[K]>}`
          : K
        : never;
    }[keyof T]
  : never;

export type TranslationKey = NestedKeyOf<typeof enUS>;

/**
 * Get translation by key
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const keys = key.split('.');
  let value: unknown = translations[currentLocale];

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      // Fallback to English
      value = translations['en-US'];
      for (const fallbackKey of keys) {
        if (value && typeof value === 'object' && fallbackKey in value) {
          value = (value as Record<string, unknown>)[fallbackKey];
        } else {
          return key; // Return key if not found
        }
      }
      break;
    }
  }

  if (typeof value !== 'string') {
    return key;
  }

  // Replace parameters
  if (params) {
    let result = value;
    for (const [paramKey, paramValue] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'), String(paramValue));
    }
    return result;
  }

  return value;
}

/**
 * React hook for translations
 * Uses useSyncExternalStore to ensure components re-render when language changes
 */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Return stable translation function (based on current locale)
  // Use useMemo + inline function to ensure translation is correct when locale changes
  const translate = useMemo(() => {
    // Explicitly use locale to ensure dependency is valid (t function uses currentLocale global state internally)
    const CurrentLocale = locale;
    return (key: TranslationKey, params?: Record<string, string | number>): string => {
      void CurrentLocale; // Ensure function is recreated when locale changes
      return t(key, params);
    };
  }, [locale]);

  return {
    t: translate,
    locale,
    setLocale,
    locales: SUPPORTED_LOCALES,
  };
}

// Initialize locale on load - default to system-detected language
// Note: useLocaleSync hook will override this setting after App loads
const detectedLocale = detectLocale();
currentLocale = detectedLocale;

export default { t, getLocale, setLocale, detectLocale, SUPPORTED_LOCALES };
