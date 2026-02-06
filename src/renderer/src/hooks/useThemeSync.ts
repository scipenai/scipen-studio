/**
 * @file useThemeSync.ts - Theme sync Hook
 * @description Automatically applies interface theme based on user settings, supports light, dark, and system theme
 * @depends useSettings
 */
import { useEffect } from 'react';
import { useSettings } from '../services/core';

/**
 * Syncs UI theme based on user settings.
 * Supports light, dark, and system-preference modes.
 *
 * @sideeffect Modifies document.documentElement.classList to apply theme classes
 */
export function useThemeSync() {
  const settings = useSettings();
  const theme = settings.ui.theme;

  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'light') {
      root.classList.add('light-theme');
      root.classList.remove('dark-theme');
    } else if (theme === 'dark') {
      root.classList.add('dark-theme');
      root.classList.remove('light-theme');
    } else {
      // Follow system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('light-theme', !prefersDark);
      root.classList.toggle('dark-theme', prefersDark);
    }
  }, [theme]);
}
