/**
 * @file ThemeService.ts - Theme Management Service
 * @description Implements zero JS overhead theme switching through CSS variables, supporting system following and custom themes
 * @depends CSS Variables
 */

import { Emitter, type IDisposable } from '../../../../shared/utils';

// ====== Types ======

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeColors {
  '--scipen-bg-primary': string;
  '--scipen-bg-secondary': string;
  '--scipen-bg-tertiary': string;
  '--scipen-bg-elevated': string;

  '--scipen-fg-primary': string;
  '--scipen-fg-secondary': string;
  '--scipen-fg-muted': string;
  '--scipen-fg-disabled': string;

  '--scipen-border': string;
  '--scipen-border-strong': string;

  '--scipen-accent': string;
  '--scipen-accent-hover': string;
  '--scipen-accent-active': string;
  '--scipen-accent-muted': string;

  '--scipen-success': string;
  '--scipen-warning': string;
  '--scipen-error': string;
  '--scipen-info': string;

  '--scipen-shadow-sm': string;
  '--scipen-shadow-md': string;
  '--scipen-shadow-lg': string;

  [key: `--scipen-${string}`]: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  type: 'light' | 'dark';
  colors: Partial<ThemeColors>;
}

// ====== Built-in Themes ======

const DARK_THEME: ThemeColors = {
  '--scipen-bg-primary': '#0a0a0a',
  '--scipen-bg-secondary': '#141414',
  '--scipen-bg-tertiary': '#1e1e1e',
  '--scipen-bg-elevated': '#252525',

  '--scipen-fg-primary': '#ffffff',
  '--scipen-fg-secondary': '#a0a0a0',
  '--scipen-fg-muted': '#6a6a6a',
  '--scipen-fg-disabled': '#4a4a4a',

  '--scipen-border': '#2a2a2a',
  '--scipen-border-strong': '#3a3a3a',

  '--scipen-accent': '#0ea5e9',
  '--scipen-accent-hover': '#38bdf8',
  '--scipen-accent-active': '#0284c7',
  '--scipen-accent-muted': 'rgba(14, 165, 233, 0.2)',

  '--scipen-success': '#22c55e',
  '--scipen-warning': '#f59e0b',
  '--scipen-error': '#ef4444',
  '--scipen-info': '#3b82f6',

  '--scipen-shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.3)',
  '--scipen-shadow-md': '0 4px 6px rgba(0, 0, 0, 0.4)',
  '--scipen-shadow-lg': '0 10px 15px rgba(0, 0, 0, 0.5)',
};

/** Solarized Light variant */
const LIGHT_THEME: ThemeColors = {
  '--scipen-bg-primary': '#fdf6e3',
  '--scipen-bg-secondary': '#eee8d5',
  '--scipen-bg-tertiary': '#ddd6c1',
  '--scipen-bg-elevated': '#ffffff',

  '--scipen-fg-primary': '#2c3e44',
  '--scipen-fg-secondary': '#6b7d84',
  '--scipen-fg-muted': '#93a1a1',
  '--scipen-fg-disabled': '#b0bfbf',

  '--scipen-border': '#bfb7a3',
  '--scipen-border-strong': '#a8a090',

  '--scipen-accent': '#1a6ba8',
  '--scipen-accent-hover': '#1d4ed8',
  '--scipen-accent-active': '#1e40af',
  '--scipen-accent-muted': 'rgba(26, 107, 168, 0.15)',

  '--scipen-success': '#166534',
  '--scipen-warning': '#854d0e',
  '--scipen-error': '#b91c1c',
  '--scipen-info': '#1d4ed8',

  '--scipen-shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.1)',
  '--scipen-shadow-md': '0 4px 6px rgba(0, 0, 0, 0.12)',
  '--scipen-shadow-lg': '0 10px 15px rgba(0, 0, 0, 0.15)',
};

// ====== Theme Service Implementation ======

class ThemeServiceImpl implements IDisposable {
  private static instance: ThemeServiceImpl;

  private _mode: ThemeMode = 'system';
  private _actualTheme: 'light' | 'dark' = 'dark';
  private readonly _themes: Map<string, ThemeDefinition> = new Map();
  private _currentThemeId: string | null = null;
  private _systemThemeQuery: MediaQueryList | null = null;
  private _systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

  private readonly _onDidChangeTheme = new Emitter<{ mode: ThemeMode; actual: 'light' | 'dark' }>();
  readonly onDidChangeTheme = this._onDidChangeTheme.event;

  private readonly _onDidChangeColors = new Emitter<Partial<ThemeColors>>();
  readonly onDidChangeColors = this._onDidChangeColors.event;

  private constructor() {
    this._setupSystemThemeListener();
    this._applyTheme(this._getActualTheme());
  }

  static getInstance(): ThemeServiceImpl {
    if (!ThemeServiceImpl.instance) {
      ThemeServiceImpl.instance = new ThemeServiceImpl();
    }
    return ThemeServiceImpl.instance;
  }

  private _setupSystemThemeListener(): void {
    if (typeof window === 'undefined') return;

    this._systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

    this._systemThemeListener = (e: MediaQueryListEvent) => {
      if (this._mode === 'system') {
        const actual = e.matches ? 'dark' : 'light';
        this._applyTheme(actual);
        this._actualTheme = actual;
        this._onDidChangeTheme.fire({ mode: this._mode, actual });
      }
    };

    this._systemThemeQuery.addEventListener('change', this._systemThemeListener);
  }

  private _getActualTheme(): 'light' | 'dark' {
    if (this._mode === 'system') {
      return this._systemThemeQuery?.matches ? 'dark' : 'light';
    }
    return this._mode;
  }

  private _applyTheme(type: 'light' | 'dark'): void {
    const root = document.documentElement;
    const colors = type === 'light' ? LIGHT_THEME : DARK_THEME;

    this._applyCSSVariables(colors);

    // Keep class for legacy code compatibility
    root.classList.remove('light-theme', 'dark-theme');
    root.classList.add(`${type}-theme`);

    // Support native form controls theming
    root.style.colorScheme = type;

    this._actualTheme = type;
  }

  private _applyCSSVariables(colors: Partial<ThemeColors>): void {
    const root = document.documentElement;

    for (const [key, value] of Object.entries(colors)) {
      if (value !== undefined) {
        root.style.setProperty(key, value);
      }
    }

    this._onDidChangeColors.fire(colors);
  }

  setTheme(mode: ThemeMode): void {
    if (mode === this._mode) return;

    this._mode = mode;
    const actual = this._getActualTheme();
    this._applyTheme(actual);
    this._onDidChangeTheme.fire({ mode, actual });
  }

  getThemeMode(): ThemeMode {
    return this._mode;
  }

  getActualTheme(): 'light' | 'dark' {
    return this._actualTheme;
  }

  registerTheme(theme: ThemeDefinition): IDisposable {
    this._themes.set(theme.id, theme);

    return {
      dispose: () => {
        this._themes.delete(theme.id);
        if (this._currentThemeId === theme.id) {
          this._currentThemeId = null;
          this._applyTheme(this._getActualTheme());
        }
      },
    };
  }

  applyTheme(themeId: string): boolean {
    const theme = this._themes.get(themeId);
    if (!theme) {
      console.warn(`[ThemeService] Theme not found: ${themeId}`);
      return false;
    }

    const baseColors = theme.type === 'light' ? LIGHT_THEME : DARK_THEME;
    this._applyCSSVariables({ ...baseColors, ...theme.colors });

    const root = document.documentElement;
    root.classList.remove('light-theme', 'dark-theme');
    root.classList.add(`${theme.type}-theme`);
    root.style.colorScheme = theme.type;

    this._currentThemeId = themeId;
    this._actualTheme = theme.type;
    this._onDidChangeTheme.fire({ mode: this._mode, actual: theme.type });

    return true;
  }

  applyCustomColors(colors: Partial<ThemeColors>): void {
    this._applyCSSVariables(colors);
  }

  resetToDefault(): void {
    this._currentThemeId = null;
    this._applyTheme(this._getActualTheme());
  }

  getRegisteredThemes(): ThemeDefinition[] {
    return Array.from(this._themes.values());
  }

  getColors(): ThemeColors {
    return this._actualTheme === 'light' ? { ...LIGHT_THEME } : { ...DARK_THEME };
  }

  getColor(variable: keyof ThemeColors): string {
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  }

  toggleTheme(): void {
    if (this._mode === 'system') {
      // In system mode, switch to opposite of current actual theme
      this.setTheme(this._actualTheme === 'dark' ? 'light' : 'dark');
    } else {
      this.setTheme(this._mode === 'dark' ? 'light' : 'dark');
    }
  }

  dispose(): void {
    if (this._systemThemeQuery && this._systemThemeListener) {
      this._systemThemeQuery.removeEventListener('change', this._systemThemeListener);
    }
    this._themes.clear();
    this._onDidChangeTheme.dispose();
    this._onDidChangeColors.dispose();
  }
}

export const ThemeService = ThemeServiceImpl.getInstance();

/** Exported for testing */
export { ThemeServiceImpl };

// ====== Preset Themes ======

export const BuiltinThemes: ThemeDefinition[] = [
  {
    id: 'scipen-dark',
    name: 'SciPen Dark',
    type: 'dark',
    colors: {},
  },
  {
    id: 'scipen-light',
    name: 'SciPen Light (Solarized)',
    type: 'light',
    colors: {},
  },
  {
    id: 'midnight-blue',
    name: 'Midnight Blue',
    type: 'dark',
    colors: {
      '--scipen-bg-primary': '#0f172a',
      '--scipen-bg-secondary': '#1e293b',
      '--scipen-bg-tertiary': '#334155',
      '--scipen-accent': '#6366f1',
      '--scipen-accent-hover': '#818cf8',
    },
  },
  {
    id: 'forest-green',
    name: 'Forest Green',
    type: 'dark',
    colors: {
      '--scipen-bg-primary': '#0c1f1a',
      '--scipen-bg-secondary': '#14312a',
      '--scipen-bg-tertiary': '#1c453b',
      '--scipen-accent': '#10b981',
      '--scipen-accent-hover': '#34d399',
    },
  },
  {
    id: 'warm-sunset',
    name: 'Warm Sunset',
    type: 'dark',
    colors: {
      '--scipen-bg-primary': '#1f1410',
      '--scipen-bg-secondary': '#2d1f19',
      '--scipen-bg-tertiary': '#3d2a22',
      '--scipen-accent': '#f97316',
      '--scipen-accent-hover': '#fb923c',
    },
  },
];

// ============ React Hooks ============

import { useCallback, useEffect, useState } from 'react';

/**
 * React Hook: 使用主题服务
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(ThemeService.getThemeMode());
  const [actual, setActual] = useState<'light' | 'dark'>(ThemeService.getActualTheme());

  useEffect(() => {
    const dispose = ThemeService.onDidChangeTheme(
      (event: { mode: ThemeMode; actual: 'light' | 'dark' }) => {
        setModeState(event.mode);
        setActual(event.actual);
      }
    );
    return () => dispose.dispose();
  }, []);

  const setTheme = useCallback((newMode: ThemeMode) => {
    ThemeService.setTheme(newMode);
  }, []);

  const toggleTheme = useCallback(() => {
    ThemeService.toggleTheme();
  }, []);

  return {
    mode,
    actual,
    isDark: actual === 'dark',
    isLight: actual === 'light',
    setTheme,
    toggleTheme,
  };
}

export function useThemeColor(variable: keyof ThemeColors): string {
  const [color, setColor] = useState(() => ThemeService.getColor(variable));

  useEffect(() => {
    const dispose = ThemeService.onDidChangeColors(() => {
      setColor(ThemeService.getColor(variable));
    });
    return () => dispose.dispose();
  }, [variable]);

  return color;
}
