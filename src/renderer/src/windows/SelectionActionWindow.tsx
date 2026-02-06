/**
 * @file SelectionActionWindow.tsx - Selection action window
 * @description Floating window after text selection, providing text preview, knowledge base selection, and one-click storage functionality
 */

import type {
  KnowledgeLibraryDTO,
  SelectionAddToKnowledgeDTO,
  SelectionCaptureDTO,
} from '@shared/ipc/types';
import { useCallback, useEffect, useState } from 'react';
import { ConfigKeys, api } from '../api';
import { setLocale, useTranslation, type LocaleKey } from '../locales';

/**
 * Selection action window component
 */
const SelectionActionWindow: React.FC = () => {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>('');
  const [libraries, setLibraries] = useState<KnowledgeLibraryDTO[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
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

  // Listen to selection data from main process
  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      const selectionData = data as SelectionCaptureDTO;
      setText(selectionData.text || '');
      setNote('');
      setError(null);
      setSuccess(false);
    });

    return () => {
      if (typeof dispose === 'function') {
        dispose();
      }
    };
  }, []);

  // Load knowledge base list (only once on mount)
  useEffect(() => {
    let isMounted = true;

    const loadLibraries = async () => {
      setIsLoading(true);
      try {
        const libs = await api.knowledge.getLibraries();
        if (isMounted && Array.isArray(libs)) {
          setLibraries(libs);
          // Select first library by default
          if (libs.length > 0) {
            setSelectedLibraryId(libs[0].id);
          }
        }
      } catch (err) {
        console.error('[SelectionAction] Failed to load knowledge bases:', err);
        if (isMounted) {
          setError(t('selection.errorLoadFailed'));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadLibraries();

    return () => {
      isMounted = false;
    };
  }, [t]);

  // Save to knowledge base
  const handleSave = useCallback(async () => {
    if (!selectedLibraryId || !text.trim()) {
      setError(t('selection.errorSelectAndText'));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const dto: SelectionAddToKnowledgeDTO = {
        libraryId: selectedLibraryId,
        text: text.trim(),
        note: note.trim() || undefined,
        metadata: {
          capturedAt: new Date().toISOString(),
        },
      };

      const result = await api.selection.addToKnowledge(dto);

      if (result?.success) {
        setSuccess(true);
        // Auto-close window after 1.5 seconds
        setTimeout(() => {
          api.selection.hideActionWindow();
        }, 1500);
      } else {
        setError(result?.error || t('selection.errorSaveFailed'));
      }
    } catch (err) {
      console.error('[SelectionAction] Save failed:', err);
      setError(`${t('selection.errorSaveFailed')}: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedLibraryId, text, note, t]);

  // Cancel/close
  const handleCancel = useCallback(() => {
    api.selection.hideActionWindow();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancel();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCancel, handleSave]);

  const isLight = theme === 'light';

  return (
    <div className={`selection-action-container ${isLight ? 'light' : ''}`}>
      {/* Title bar - draggable */}
      <div className="title-bar">
        <span className="title">{t('selection.title')}</span>
        <button className="close-btn" onClick={handleCancel} title={t('selection.closeEsc')}>
          ×
        </button>
      </div>

      {/* Main content area */}
      <div className="content">
        {/* Text preview */}
        <div className="section">
          <label className="label">{t('selection.selectedText')}</label>
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('selection.textPlaceholder')}
            rows={7}
          />
        </div>

        {/* Knowledge base selection */}
        <div className="section">
          <label className="label">{t('selection.targetKnowledgeBase')}</label>
          {isLoading ? (
            <div className="loading">{t('common.loading')}</div>
          ) : libraries.length === 0 ? (
            <div className="empty">{t('selection.noKnowledgeBases')}</div>
          ) : (
            <select
              className="select"
              value={selectedLibraryId}
              onChange={(e) => setSelectedLibraryId(e.target.value)}
            >
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Note input */}
        <div className="section">
          <label className="label">{t('selection.noteOptional')}</label>
          <input
            type="text"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('selection.notePlaceholder')}
          />
        </div>

        {/* Error/success messages */}
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{t('selection.success')}</div>}

        {/* Action buttons */}
        <div className="actions">
          <button className="btn btn-cancel" onClick={handleCancel}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-save"
            onClick={handleSave}
            disabled={isSaving || !selectedLibraryId || !text.trim()}
          >
            {isSaving ? t('selection.saving') : t('selection.saveToKnowledge')}
          </button>
        </div>

        {/* Keyboard shortcuts hint */}
        <div className="shortcuts">
          <span>{t('selection.shortcutSave')}</span>
          <span>{t('selection.shortcutClose')}</span>
        </div>
      </div>

      {/* Inline styles */}
      <style>{`
        html, body {
          background: transparent !important;
        }

        /* ===== Dark Theme (Default) ===== */
        .selection-action-container {
          width: 100%;
          height: 100%;
          background: rgba(24, 24, 27, 0.95);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(20, 184, 166, 0.15);
          border-radius: 12px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #e4e4e7;
        }

        /* ===== Light Theme ===== */
        .selection-action-container.light {
          background: rgba(250, 248, 243, 0.98);
          border: 1px solid rgba(13, 148, 136, 0.2);
          box-shadow: 0 25px 50px -12px rgba(139, 119, 91, 0.2);
          color: #2d2a24;
        }

        .title-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(39, 39, 42, 0.8);
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          -webkit-app-region: drag;
        }

        .light .title-bar {
          background: rgba(235, 231, 220, 0.9);
          border-bottom: 1px solid rgba(139, 119, 91, 0.1);
        }

        .title {
          font-size: 14px;
          font-weight: 600;
          color: #fafafa;
        }

        .light .title {
          color: #2d2a24;
        }

        .close-btn {
          -webkit-app-region: no-drag;
          width: 24px;
          height: 24px;
          border: none;
          background: transparent;
          color: #a1a1aa;
          font-size: 18px;
          cursor: pointer;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .light .close-btn {
          color: #7a7365;
        }

        .close-btn:hover {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .light .close-btn:hover {
          background: rgba(185, 28, 28, 0.1);
          color: #b91c1c;
        }

        .content {
          flex: 1;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          overflow-y: auto;
        }

        .section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .label {
          font-size: 12px;
          font-weight: 500;
          color: #a1a1aa;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .light .label {
          color: #5c564a;
        }

        .textarea {
          background: rgba(39, 39, 42, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 13px;
          line-height: 1.5;
          color: #e4e4e7;
          resize: vertical;
          min-height: 120px;
          transition: border-color 0.15s ease;
        }

        .light .textarea {
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(139, 119, 91, 0.2);
          color: #2d2a24;
        }

        .textarea:focus {
          outline: none;
          border-color: #14b8a6;
        }

        .select, .input {
          background: rgba(39, 39, 42, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 13px;
          color: #e4e4e7;
          transition: border-color 0.15s ease;
        }

        .light .select, .light .input {
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(139, 119, 91, 0.2);
          color: #2d2a24;
        }

        .select:focus, .input:focus {
          outline: none;
          border-color: #14b8a6;
        }

        .loading, .empty {
          padding: 10px 12px;
          font-size: 13px;
          color: #71717a;
          font-style: italic;
        }

        .light .loading, .light .empty {
          color: #7a7365;
        }

        .error {
          padding: 8px 12px;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 6px;
          font-size: 12px;
          color: #fca5a5;
        }

        .light .error {
          background: rgba(185, 28, 28, 0.08);
          border: 1px solid rgba(185, 28, 28, 0.2);
          color: #b91c1c;
        }

        .success {
          padding: 8px 12px;
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.3);
          border-radius: 6px;
          font-size: 12px;
          color: #86efac;
        }

        .light .success {
          background: rgba(5, 150, 105, 0.08);
          border: 1px solid rgba(5, 150, 105, 0.2);
          color: #059669;
        }

        .actions {
          display: flex;
          gap: 12px;
          margin-top: auto;
          padding-top: 12px;
        }

        .btn {
          flex: 1;
          padding: 10px 16px;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-cancel {
          background: rgba(63, 63, 70, 0.8);
          color: #a1a1aa;
        }

        .light .btn-cancel {
          background: rgba(139, 119, 91, 0.15);
          color: #5c564a;
        }

        .btn-cancel:hover:not(:disabled) {
          background: rgba(82, 82, 91, 0.8);
          color: #e4e4e7;
        }

        .light .btn-cancel:hover:not(:disabled) {
          background: rgba(139, 119, 91, 0.25);
          color: #2d2a24;
        }

        .btn-save {
          background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
          color: white;
        }

        .btn-save:hover:not(:disabled) {
          background: linear-gradient(135deg, #2dd4bf 0%, #14b8a6 100%);
          transform: translateY(-1px);
        }

        .shortcuts {
          display: flex;
          justify-content: center;
          gap: 16px;
          padding-top: 8px;
          font-size: 11px;
          color: #52525b;
        }

        .light .shortcuts {
          color: #7a7365;
        }

        .shortcuts span {
          padding: 2px 6px;
          background: rgba(39, 39, 42, 0.6);
          border-radius: 4px;
        }

        .light .shortcuts span {
          background: rgba(139, 119, 91, 0.12);
        }
      `}</style>
    </div>
  );
};

export default SelectionActionWindow;
