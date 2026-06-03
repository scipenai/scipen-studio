/**
 * @file useLocaleSync.ts - Locale sync Hook
 * @description Automatically applies interface language based on user settings
 */
import { useEffect } from 'react';
import { type LocaleKey, setLocale } from '../locales';
import { useSettings } from '../services/core';

export function useLocaleSync() {
  const language = useSettings((s) => s.ui?.language) as LocaleKey | undefined;

  useEffect(() => {
    if (language && (language === 'zh-CN' || language === 'en-US')) {
      console.info('[useLocaleSync] Setting locale to:', language);
      setLocale(language);
    }
  }, [language]);
}
