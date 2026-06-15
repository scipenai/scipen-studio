/**
 * @file NewLabelDialog - modal dialog that creates a label over every open tab.
 *
 * Listens to `historyUIBus.onOpenCreateLabel`. Renders nothing when idle.
 * On submit, snapshots every dirty + saved tab's current content into the
 * BlobStore via `api.history.putBlob`, then writes one `history.createLabel`
 * crossing all of them — atomic on the SQLite side.
 */

import { Loader2, Tag, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { getEditorService, getProjectRuntimeContext } from '../../services/core';
import { historyUIBus } from '../../services/core/HistoryUIBus';

type SubmitState = 'idle' | 'submitting' | 'error';

export function NewLabelDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const disposable = historyUIBus.onOpenCreateLabel(() => {
      setIsOpen(true);
      setSubmitState('idle');
      setError(null);
      setName('');
      setDescription('');
    });
    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    if (isOpen) {
      // Defer focus to the next tick so the input is in the DOM.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  const close = useCallback(() => {
    if (submitState === 'submitting') return;
    setIsOpen(false);
  }, [submitState]);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || submitState === 'submitting') return;

    const projectId = getProjectRuntimeContext().projectId;
    if (!projectId) {
      setSubmitState('error');
      setError(t('history.labelNoProject'));
      return;
    }
    const tabs = getEditorService().tabs;
    if (tabs.length === 0) {
      setSubmitState('error');
      setError(t('history.labelNoFiles'));
      return;
    }

    setSubmitState('submitting');
    setError(null);

    try {
      const encoder = new TextEncoder();
      const files: Array<{ fileId: string; blobHashHex: string; version: number }> = [];
      for (const tab of tabs) {
        // OT id is the canonical fileId when available; otherwise the absolute
        // path doubles as the key (path is stable per-project).
        const fileId = tab._id ?? tab.path;
        const bytes = encoder.encode(tab.content);
        const result = await api.history.putBlob({ projectId, bytes });
        files.push({ fileId, blobHashHex: result.hashHex, version: 0 });
      }
      await api.history.createLabel({
        projectId,
        name: trimmed,
        description: description.trim() || undefined,
        kind: 'manual',
        createdBy: 'user',
        files,
      });
      setIsOpen(false);
    } catch (e) {
      setSubmitState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name, description, submitState, t]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [close, submit]
  );

  if (!isOpen) return null;

  const canSubmit = name.trim().length > 0 && submitState !== 'submitting';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('history.createLabel')}
      onKeyDown={handleKeyDown}
      onClick={close}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-2">
          <Tag size={14} className="text-[var(--color-accent)]" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            {t('history.createLabel')}
          </span>
          <button
            type="button"
            onClick={close}
            disabled={submitState === 'submitting'}
            aria-label={t('history.close')}
            className="ml-auto rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
          >
            <X size={12} />
          </button>
        </div>

        <div className="space-y-2 px-3 py-3 text-[12px]">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {t('history.createLabelDesc')}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('history.labelNamePlaceholder')}
            maxLength={256}
            disabled={submitState === 'submitting'}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('history.labelDescriptionPlaceholder')}
            maxLength={2048}
            rows={2}
            disabled={submitState === 'submitting'}
            className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
          />
          {error && (
            <div className="text-[10px] text-[var(--color-error)]" role="alert">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-[var(--color-text-muted)]">
              Ctrl+Enter · Esc
            </span>
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                onClick={close}
                disabled={submitState === 'submitting'}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
              >
                {t('history.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="flex items-center gap-1 rounded border border-[var(--color-accent)]/50 bg-[var(--color-accent)] px-2.5 py-0.5 text-[11px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitState === 'submitting' && (
                  <Loader2 size={11} className="animate-spin" />
                )}
                {submitState === 'submitting' ? t('history.labelCreating') : t('history.submit')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
