/**
 * @file ThreadHistoryDrawer — vertical thread list for the SNACA chat panel.
 *
 * Active thread is highlighted; double-click / F2 enters inline rename mode;
 * trash icon deletes (with confirm). Sort = last_active_at DESC, matching
 * the server's `list_thread_summaries`. The drawer is a presentation-only
 * component; all RPC / cache handling lives in ChatSidebar.
 */

import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../locales';
import type { ThreadSummary } from '../../services/agent/AgentClientService';

interface ThreadHistoryDrawerProps {
  open: boolean;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onClose: () => void;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}

export function ThreadHistoryDrawer({
  open,
  threads,
  activeThreadId,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ThreadHistoryDrawerProps): React.ReactElement | null {
  const { t } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Most-recently-active first; tolerate missing timestamps from older sidecars.
  const sorted = useMemo(
    () =>
      [...threads].sort((a, b) => {
        const ax = Date.parse(a.last_active_at) || 0;
        const bx = Date.parse(b.last_active_at) || 0;
        return bx - ax;
      }),
    [threads]
  );

  // Cancel rename when drawer closes so reopening starts clean.
  useEffect(() => {
    if (!open) setRenamingId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstAction = drawerRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)'
    );

    (firstAction ?? drawerRef.current)?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  const handleDrawerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ??
          []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  const beginRename = useCallback((thread: ThreadSummary) => {
    setRenamingId(thread.thread_id);
    setDraftTitle(thread.title || '');
  }, []);

  const commitRename = useCallback(
    (threadId: string) => {
      const next = draftTitle.trim();
      if (next && next.length > 0) {
        const previous = threads.find((th) => th.thread_id === threadId)?.title ?? '';
        if (next !== previous) {
          onRename(threadId, next);
        }
      }
      setRenamingId(null);
    },
    [draftTitle, onRename, threads]
  );

  if (!open) return null;

  return (
    <div
      ref={drawerRef}
      className="absolute inset-0 z-30 flex flex-col bg-[var(--color-bg-secondary)]"
      role="dialog"
      aria-modal="true"
      aria-label={t('thread.historyTitle')}
      tabIndex={-1}
      onKeyDown={handleDrawerKeyDown}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {t('thread.historyTitle')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="cursor-pointer rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            title={t('thread.newThread')}
            aria-label={t('thread.newThread')}
            onClick={onCreate}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cursor-pointer rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-muted)]">
            {t('thread.historyEmpty')}
          </div>
        ) : (
          sorted.map((thread) => {
            const isActive = thread.thread_id === activeThreadId;
            const isRenaming = renamingId === thread.thread_id;
            return (
              <div
                key={thread.thread_id}
                className={`group flex items-center gap-2 border-l-2 px-3 py-2 text-[12px] ${
                  isActive
                    ? 'border-[var(--color-accent)] bg-[var(--color-bg-hover)]'
                    : 'border-transparent hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                <button
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  className="min-w-0 flex-1 cursor-pointer rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  onClick={() => !isRenaming && onSelect(thread.thread_id)}
                  onDoubleClick={() => beginRename(thread)}
                >
                  {isRenaming ? (
                    <input
                      autoFocus
                      type="text"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onBlur={() => commitRename(thread.thread_id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename(thread.thread_id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      placeholder={t('thread.renamePlaceholder')}
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    />
                  ) : (
                    <>
                      <div className="truncate text-[var(--color-text-primary)]">
                        {thread.title || t('thread.untitled')}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {thread.turn_count > 0
                          ? t('thread.turnCount', { count: String(thread.turn_count) })
                          : t('thread.noTurns')}
                      </div>
                    </>
                  )}
                </button>
                {!isRenaming && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button
                      type="button"
                      className="cursor-pointer rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                      title={t('thread.rename')}
                      aria-label={t('thread.rename')}
                      onClick={(e) => {
                        e.stopPropagation();
                        beginRename(thread);
                      }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                    <DeleteButton
                      onConfirm={() => onDelete(thread.thread_id)}
                      confirmText={t('thread.deleteConfirm')}
                      title={t('thread.delete')}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

interface DeleteButtonProps {
  onConfirm: () => void;
  confirmText: string;
  title: string;
}

/**
 * Two-click delete: first click arms, second click fires. Auto-disarms
 * after 2s. Native `window.confirm` would freeze the sidebar; this is the
 * lightweight inline alternative.
 */
function DeleteButton({ onConfirm, confirmText, title }: DeleteButtonProps): React.ReactElement {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    setArmed(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => disarm, [disarm]);

  return (
    <button
      type="button"
      className={`cursor-pointer rounded p-1 hover:bg-[var(--color-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        armed
          ? 'text-red-500'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
      }`}
      title={armed ? confirmText : title}
      aria-label={armed ? confirmText : title}
      aria-pressed={armed}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          onConfirm();
          disarm();
        } else {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 2000);
        }
      }}
    >
      <Trash2 size={12} aria-hidden="true" />
    </button>
  );
}
