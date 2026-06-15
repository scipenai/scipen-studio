/**
 * @file BrowseLabelsDialog - read-only label inspector.
 *
 * Lists every snapshot label for the active project and, on selection, shows
 * the per-file blob hashes captured at label time. Restore is intentionally
 * disabled in P1 — the actual file rewrite + OT rebroadcast lives in P2. The
 * "Restore" button is rendered but greyed so the path is visible while we
 * build the underlying machinery.
 */

import { ChevronLeft, FolderOpen, Loader2, RotateCcw, Tag, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { api, type HistoryLabelDTO } from '../../api';
import { useTranslation, type TranslationKey } from '../../locales';
import { getProjectRuntimeContext } from '../../services/core';
import { historyUIBus } from '../../services/core/HistoryUIBus';
import { applySnapshotToOpenTabs } from '../../utils/historyRestore';

type ViewState =
  | { kind: 'list'; labels: HistoryLabelDTO[] | null; error: string | null }
  | { kind: 'detail'; label: HistoryLabelDTO; files: string[] | null; error: string | null };

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

export function BrowseLabelsDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'list', labels: null, error: null });
  const [loading, setLoading] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' });
  const containerRef = useRef<HTMLDivElement>(null);

  const loadLabels = useCallback(async (): Promise<void> => {
    const projectId = getProjectRuntimeContext().projectId;
    if (!projectId) {
      setView({ kind: 'list', labels: [], error: 'labelNoProject' });
      return;
    }
    setLoading(true);
    try {
      const labels = await api.history.listLabels({ projectId, limit: 200 });
      setView({ kind: 'list', labels, error: null });
    } catch (e) {
      setView({ kind: 'list', labels: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const disposable = historyUIBus.onOpenBrowseLabels(() => {
      setIsOpen(true);
      setView({ kind: 'list', labels: null, error: null });
      void loadLabels();
    });
    return () => disposable.dispose();
  }, [loadLabels]);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => containerRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  const close = useCallback(() => setIsOpen(false), []);

  const openDetail = useCallback(async (label: HistoryLabelDTO): Promise<void> => {
    setView({ kind: 'detail', label, files: null, error: null });
    setLoading(true);
    try {
      const map = await api.history.resolveLabelSnapshot({
        projectId: label.projectId,
        labelId: label.id,
      });
      setView({ kind: 'detail', label, files: Object.keys(map).sort(), error: null });
    } catch (e) {
      setView({
        kind: 'detail',
        label,
        files: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const backToList = useCallback(() => {
    setView({ kind: 'list', labels: null, error: null });
    setRestore({ kind: 'idle' });
    void loadLabels();
  }, [loadLabels]);

  /**
   * P2 minimal restore:
   * - Resolve the label → file content map.
   * - For every entry, find the matching open tab (by OT id or absolute path)
   *   and rewrite both the on-disk file AND the editor tab so the editor
   *   doesn't fight the new content.
   * - Files referenced by the label but NOT currently open are skipped — the
   *   safer default than silently writing to closed files; P3 will add a
   *   "Restore all (including closed)" affordance with stronger confirmation.
   * - Undo: every rewrite is one Monaco edit step → Ctrl+Z restores.
   */
  const doRestore = useCallback(async (label: HistoryLabelDTO): Promise<void> => {
    const ok = await api.dialog.confirm(
      t('history.restoreConfirm', { name: label.name }),
      t('history.restoreConfirmTitle')
    );
    if (!ok) return;

    setRestore({ kind: 'restoring' });
    try {
      const snapshot = await api.history.resolveLabelSnapshot({
        projectId: label.projectId,
        labelId: label.id,
      });
      const { count } = await applySnapshotToOpenTabs(snapshot);
      setRestore({ kind: 'done', count });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRestore({
        kind: 'error',
        message: msg === 'no open tabs' ? t('history.restoreNoTabs') : msg,
      });
    }
  }, [t]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view.kind === 'detail') backToList();
        else close();
      }
    },
    [view.kind, backToList, close]
  );

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('history.browseLabels')}
      onClick={close}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg focus:outline-none"
      >
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-2">
          {view.kind === 'detail' ? (
            <button
              type="button"
              onClick={backToList}
              aria-label={t('history.close')}
              className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
            >
              <ChevronLeft size={14} />
            </button>
          ) : (
            <FolderOpen size={14} className="text-[var(--color-accent)]" />
          )}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            {view.kind === 'detail' ? view.label.name : t('history.browseLabels')}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('history.close')}
            className="ml-auto rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
          >
            <X size={12} />
          </button>
        </div>

        {view.kind === 'list' && (view.labels ?? []).length > 1 && (
          <TimelineStrip
            labels={view.labels ?? []}
            onSelect={(l) => void openDetail(l)}
          />
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 text-[12px]">
          {loading && (
            <div className="flex items-center gap-1.5 py-2 text-[11px] text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              {t('history.labelCreating')}
            </div>
          )}

          {view.kind === 'list' && !loading && (
            <LabelList
              labels={view.labels ?? []}
              errorKey={view.error}
              onOpen={(l) => void openDetail(l)}
              t={t}
            />
          )}

          {view.kind === 'detail' && !loading && (
            <LabelDetail
              label={view.label}
              files={view.files ?? []}
              error={view.error}
              restore={restore}
              onRestore={() => void doRestore(view.label)}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

function LabelList({
  labels,
  errorKey,
  onOpen,
  t,
}: {
  labels: HistoryLabelDTO[];
  errorKey: string | null;
  onOpen: (l: HistoryLabelDTO) => void;
  t: T;
}): ReactElement {
  if (errorKey === 'labelNoProject') {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-text-muted)]">
        {t('history.labelNoProject')}
      </div>
    );
  }
  if (errorKey) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-error)]" role="alert">
        {errorKey}
      </div>
    );
  }
  if (labels.length === 0) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-text-muted)]">
        {t('history.labelEmpty')}
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {labels.map((l) => (
        <li key={l.id}>
          <button
            type="button"
            onClick={() => onOpen(l)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-left hover:bg-[var(--color-bg-hover)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            <Tag size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-accent)]" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
                  {l.name}
                </span>
                <KindChip kind={l.kind} t={t} />
              </div>
              {l.description && (
                <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                  {l.description}
                </div>
              )}
              <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
                {new Date(l.createdAt).toLocaleString()}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LabelDetail({
  label,
  files,
  error,
  restore,
  onRestore,
  t,
}: {
  label: HistoryLabelDTO;
  files: string[];
  error: string | null;
  restore: RestoreState;
  onRestore: () => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <KindChip kind={label.kind} t={t} />
        <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
          {new Date(label.createdAt).toLocaleString()}
        </span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
          {t('history.labelFilesCount', { count: files.length })}
        </span>
      </div>
      {label.description && (
        <div className="rounded bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
          {label.description}
        </div>
      )}
      {error && (
        <div className="text-[10px] text-[var(--color-error)]" role="alert">
          {error}
        </div>
      )}
      <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-1 font-mono text-[10px]">
        {files.map((f) => (
          <li key={f} className="truncate px-1 py-0.5 text-[var(--color-text-primary)]">
            {f}
          </li>
        ))}
      </ul>
      {restore.kind === 'done' && (
        <div className="text-[11px] text-[var(--color-success)]" role="status">
          {t('history.restoreSuccess', { count: restore.count })}
        </div>
      )}
      {restore.kind === 'error' && (
        <div className="text-[11px] text-[var(--color-error)]" role="alert">
          {t('history.restoreFailed', { error: restore.message })}
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-border-subtle)] pt-2">
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring}
          className="flex items-center gap-1 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning-muted)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-warning)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {restoring ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
          {restoring ? t('history.restoring') : t('history.restore')}
        </button>
      </div>
    </div>
  );
}

/**
 * Horizontal scrubber rendered above the label list when 2+ labels exist.
 * Each label is a colored dot positioned by its `createdAt` on a linear scale
 * (oldest at left, newest at right). Clicking a dot opens its detail. Pure
 * SVG → zero new dep, sharp on hi-DPI. Hover tooltips use the native `title`
 * attribute to stay accessible-by-default without extra CSS.
 */
function TimelineStrip({
  labels,
  onSelect,
}: {
  labels: HistoryLabelDTO[];
  onSelect: (l: HistoryLabelDTO) => void;
}): ReactElement | null {
  if (labels.length < 2) return null;
  const sorted = [...labels].sort((a, b) => a.createdAt - b.createdAt);
  const minTs = sorted[0].createdAt;
  const maxTs = sorted[sorted.length - 1].createdAt;
  const span = Math.max(1, maxTs - minTs);

  return (
    <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-3 py-2">
      <div className="relative h-6">
        {/* baseline */}
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-[var(--color-border-subtle)]"
        />
        {sorted.map((l) => {
          const pct = ((l.createdAt - minTs) / span) * 100;
          const color =
            l.kind === 'manual'
              ? 'var(--color-accent)'
              : l.kind === 'milestone'
                ? 'var(--color-warning)'
                : 'var(--color-text-muted)';
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onSelect(l)}
              title={`${l.name} · ${new Date(l.createdAt).toLocaleString()}`}
              aria-label={l.name}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full p-0 hover:scale-150 focus:scale-150 focus:outline-none"
              style={{ left: `${pct}%`, width: 8, height: 8, backgroundColor: color }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-[var(--color-text-muted)] tabular-nums">
        <span>{new Date(minTs).toLocaleDateString()}</span>
        <span>{new Date(maxTs).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function KindChip({
  kind,
  t,
}: {
  kind: HistoryLabelDTO['kind'];
  t: T;
}): ReactElement {
  const map = {
    manual: { key: 'history.labelKindManual', color: 'var(--color-accent)' },
    auto: { key: 'history.labelKindAuto', color: 'var(--color-text-muted)' },
    milestone: { key: 'history.labelKindMilestone', color: 'var(--color-warning)' },
  } as const;
  const entry = map[kind];
  return (
    <span
      className="rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider"
      style={{ borderColor: `color-mix(in srgb, ${entry.color} 50%, transparent)`, color: entry.color }}
    >
      {t(entry.key)}
    </span>
  );
}
