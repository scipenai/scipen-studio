/**
 * @file SelectionToolbar.tsx - Selection floating toolbar
 * @description Displays quick action buttons after text selection, supports theme switching
 */

import type { SelectionCaptureDTO } from '@shared/ipc/types';
import { useCallback, useEffect, useState } from 'react';
import { ConfigKeys, api } from '../api';
import { setLocale, useTranslation, type LocaleKey } from '../locales';

const MAX_PREVIEW_LENGTH = 60;

const SelectionToolbar: React.FC = () => {
  const [selection, setSelection] = useState<SelectionCaptureDTO | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const { t } = useTranslation();

  // Apply theme based on setting (light/dark/system)
  const applyTheme = useCallback((themeSetting: 'light' | 'dark' | 'system') => {
    if (themeSetting === 'light') {
      setTheme('light');
    } else if (themeSetting === 'dark') {
      setTheme('dark');
    } else {
      // system: follow system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
    }
  }, []);

  // Load theme config and subscribe to changes
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const themeSetting = await api.config.get<'light' | 'dark' | 'system'>(ConfigKeys.Theme);
        applyTheme(themeSetting ?? 'system');
      } catch {
        // Default to dark theme
        setTheme('dark');
      }
    };
    loadTheme();

    // Load locale from saved config
    const loadLocale = async () => {
      try {
        const localeSetting = await api.config.get<string>(ConfigKeys.Language);
        if (localeSetting) {
          setLocale(localeSetting as LocaleKey);
        }
      } catch {
        // Keep detected locale
      }
    };
    loadLocale();

    // Subscribe to config changes (broadcast from main window)
    const disposeConfigChanged = api.config.onChanged((data) => {
      if (data.key === 'theme') {
        applyTheme(data.value as 'light' | 'dark' | 'system');
      }
      if (data.key === 'language') {
        setLocale(data.value as LocaleKey);
      }
    });

    // Listen to system theme changes (only when config is 'system')
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = (e: MediaQueryListEvent) => {
      api.config.get<'light' | 'dark' | 'system'>(ConfigKeys.Theme).then((themeSetting) => {
        if (themeSetting === 'system') {
          setTheme(e.matches ? 'dark' : 'light');
        }
      });
    };
    mediaQuery.addEventListener('change', handleSystemChange);

    return () => {
      disposeConfigChanged();
      mediaQuery.removeEventListener('change', handleSystemChange);
    };
  }, [applyTheme]);

  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      setSelection(data);
    });

    return () => {
      if (typeof dispose === 'function') {
        dispose();
      }
    };
  }, []);

  const handleOpenActionWindow = useCallback(() => {
    if (!selection) return;
    api.selection.showActionWindow(selection);
  }, [selection]);

  const handleClose = useCallback(() => {
    api.selection.hideToolbar();
  }, []);

  const previewText = selection?.text?.trim() || '';
  const preview =
    previewText.length > MAX_PREVIEW_LENGTH
      ? `${previewText.slice(0, MAX_PREVIEW_LENGTH)}...`
      : previewText;

  const isLight = theme === 'light';

  return (
    <div className={`selection-toolbar ${isLight ? 'light' : ''}`}>
      <div className="preview">{preview || t('selection.capturedText')}</div>
      <div className="actions">
        <button
          className="btn btn-primary"
          onClick={handleOpenActionWindow}
          disabled={!previewText}
        >
          {t('selection.saveToKnowledge')}
        </button>
        <button className="btn btn-ghost" onClick={handleClose}>
          {t('common.close')}
        </button>
      </div>

      <style>{`
        html, body {
          margin: 0;
          padding: 0;
          background: transparent !important;
          width: 100%;
          height: 100%;
        }
        
        #selection-toolbar-root {
          width: 100%;
          height: 100%;
        }

        .selection-toolbar {
          width: 100%;
          height: 100%;
          background: #18181b;
          border: 1px solid rgba(20, 184, 166, 0.2);
          border-radius: 10px;
          box-shadow: 0 8px 32px -8px rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          color: #fafafa;
          gap: 10px;
          box-sizing: border-box;
        }

        .selection-toolbar.light {
          background: #faf8f3;
          border: 1px solid rgba(13, 148, 136, 0.2);
          box-shadow: 0 8px 32px -8px rgba(139, 119, 91, 0.15);
          color: #2d2a24;
        }

        .preview {
          flex: 1;
          font-size: 12px;
          color: #a1a1aa;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .light .preview {
          color: #5c564a;
        }

        .actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .btn {
          border: none;
          border-radius: 6px;
          font-size: 12px;
          padding: 6px 10px;
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-primary {
          background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: linear-gradient(135deg, #2dd4bf 0%, #14b8a6 100%);
        }

        .btn-ghost {
          background: rgba(63, 63, 70, 0.8);
          color: #a1a1aa;
        }

        .light .btn-ghost {
          background: rgba(139, 119, 91, 0.15);
          color: #5c564a;
        }

        .btn-ghost:hover {
          background: rgba(82, 82, 91, 0.8);
          color: #e4e4e7;
        }

        .light .btn-ghost:hover {
          background: rgba(139, 119, 91, 0.25);
          color: #2d2a24;
        }
      `}</style>
    </div>
  );
};

export default SelectionToolbar;
