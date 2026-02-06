/**
 * @file useLocaleSync.ts - Locale sync Hook
 * @description Automatically applies interface language based on user settings
 */
import { useEffect } from 'react';
import { type LocaleKey, setLocale } from '../locales';
import { useSettings } from '../services/core';

export function useLocaleSync() {
  const settings = useSettings();
  const language = settings.ui?.language as LocaleKey | undefined;

  useEffect(() => {
    if (language && (language === 'zh-CN' || language === 'en-US')) {
      console.log('[useLocaleSync] Setting locale to:', language);
      setLocale(language);
    }
  }, [language]);
}
