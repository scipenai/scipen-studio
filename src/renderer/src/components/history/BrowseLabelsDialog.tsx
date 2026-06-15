/**
 * @file BrowseLabelsDialog - split-panel label inspector.
 *
 * Layout (GitLens / VSCode source control inspired):
 *   ┌─────────────────────────────────────────────┐
 *   │ header                       [+ Create] [×] │
 *   │ timeline scrubber (≥2 labels)               │
 *   ├──────────────┬──────────────────────────────┤
 *   │ labels list  │ detail (files + diff + restore)
 *   │   ~35%       │   ~65%                       │
 *   │ scroll       │ empty state when no selection│
 *   └──────────────┴──────────────────────────────┘
 *
 * Why split instead of push/pop views:
 * - Cursor's modal-with-back-button is criticised for hiding context;
 *   GitLens' embedded details panel keeps the list visible while inspecting.
 * - Picking another label instantly updates the right pane — no Esc dance.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { FolderOpen, Inbox, Loader2, Plus, RotateCcw, Tag, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { api, type HistoryLabelDTO } from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useTranslation, type TranslationKey } from '../../locales';
import { getEditorService, getProjectRuntimeContext } from '../../services/core';
import { historyUIBus } from '../../services/core/HistoryUIBus';
import { historyProjectIdOf } from '../../utils/historyProjectId';
import { applySnapshotToOpenTabs } from '../../utils/historyRestore';
import { lineDiffStats } from '../../utils/lineDiffStats';
import { FileDiffOverlay } from './FileDiffOverlay';
import { HistoryFileRow, type HistoryFileSnapshot } from './HistoryFileRow';

type FileDiff = HistoryFileSnapshot;

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface DetailData {
  files: FileDiff[];
  error: string | null;
}

export function BrowseLabelsDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [labels, setLabels] = useState<HistoryLabelDTO[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' });
  const [diffViewFile, setDiffViewFile] = useState<FileDiff | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, isOpen);

  const loadLabels = useCallback(async (): Promise<void> => {
    const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
    if (!projectId) {
      setLabels([]);
      setListError('labelNoProject');
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const rows = await api.history.listLabels({ projectId, limit: 200 });
      setLabels(rows);
      // Auto-select first label so the right pane is never empty on first open.
      if (rows.length > 0 && selectedId === null) {
        setSelectedId(rows[0].id);
      }
    } catch (e) {
      setLabels([]);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    const disposable = historyUIBus.onOpenBrowseLabels(() => {
      setIsOpen(true);
      setSelectedId(null);
      setDetail(null);
      setRestore({ kind: 'idle' });
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

  const selectedLabel = useMemo<HistoryLabelDTO | null>(() => {
    if (!labels || !selectedId) return null;
    return labels.find((l) => l.id === selectedId) ?? null;
  }, [labels, selectedId]);

  // Resolve the selected label's files. Runs whenever the selection changes.
  useEffect(() => {
    if (!selectedLabel) {
      setDetail(null);
      setRestore({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setRestore({ kind: 'idle' });
    (async () => {
      try {
        const map = await api.history.resolveLabelSnapshot({
          projectId: selectedLabel.projectId,
          labelId: selectedLabel.id,
        });
        if (cancelled) return;
        const tabs = getEditorService().tabs;
        const decoder = new TextDecoder();
        const files: FileDiff[] = Object.keys(map)
          .sort()
          .map((fileId) => {
            const bytes = map[fileId];
            const beforeText = decoder.decode(bytes);
            const tab = tabs.find((tt) => tt._id === fileId || tt.path === fileId);
            if (!tab) return { fileId, stats: null, beforeText, afterText: null };
            return {
              fileId,
              stats: lineDiffStats(beforeText, tab.content),
              beforeText,
              afterText: tab.content,
            };
          });
        setDetail({ files, error: null });
      } catch (e) {
        if (cancelled) return;
        setDetail({ files: [], error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLabel]);

  const doRestore = useCallback(async (): Promise<void> => {
    if (!selectedLabel) return;
    const ok = await api.dialog.confirm(
      t('history.restoreConfirm', { name: selectedLabel.name }),
      t('history.restoreConfirmTitle')
    );
    if (!ok) return;
    setRestore({ kind: 'restoring' });
    try {
      const snapshot = await api.history.resolveLabelSnapshot({
        projectId: selectedLabel.projectId,
        labelId: selectedLabel.id,
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
  }, [selectedLabel, t]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // j/k navigate the labels list (vim style); the user is likely on the
      // dialog body, not inside an input.
      if (!labels || labels.length === 0) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = selectedId ? labels.findIndex((l) => l.id === selectedId) : -1;
        const next = labels[Math.min(idx + 1, labels.length - 1)];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = selectedId ? labels.findIndex((l) => l.id === selectedId) : 0;
        const next = labels[Math.max(idx - 1, 0)];
        if (next) setSelectedId(next.id);
      }
    },
    [close, labels, selectedId]
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t('history.browseLabels')}
          onClick={close}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <motion.div
            ref={containerRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            className="flex h-[78vh] w-[min(960px,95vw)] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl focus:outline-none"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <Header
              count={labels?.length ?? 0}
              onCreate={() => {
                close();
                historyUIBus.openCreateLabel();
              }}
              onClose={close}
              t={t}
            />

            {labels && labels.length > 1 && (
              <TimelineStrip
                labels={labels}
                selectedId={selectedId}
                onSelect={(l) => setSelectedId(l.id)}
              />
            )}

            <div className="flex min-h-0 flex-1">
              <LabelListPane
                labels={labels ?? []}
                listError={listError}
                listLoading={listLoading}
                selectedId={selectedId}
                onSelect={(l) => setSelectedId(l.id)}
                t={t}
              />
              <div className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--color-border-subtle)]">
                {!selectedLabel ? (
                  <EmptyState t={t} />
                ) : (
                  <LabelDetailPane
                    label={selectedLabel}
                    detail={detail}
                    detailLoading={detailLoading}
                    restore={restore}
                    onRestore={() => void doRestore()}
                    onViewDiff={(f) => setDiffViewFile(f)}
                    t={t}
                  />
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
      {diffViewFile && (
        <FileDiffOverlay
          fileId={diffViewFile.fileId}
          beforeText={diffViewFile.beforeText}
          afterText={diffViewFile.afterText}
          onClose={() => setDiffViewFile(null)}
        />
      )}
    </AnimatePresence>
  );
}

// ====== Header ======

function Header({
  count,
  onCreate,
  onClose,
  t,
}: {
  count: number;
  onCreate: () => void;
  onClose: () => void;
  t: T;
}): ReactElement {
  return (
    <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <FolderOpen size={14} className="text-[var(--color-accent)]" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        {t('history.browseLabels')}
      </span>
      {count > 0 && (
        <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] tabular-nums text-[var(--color-text-muted)]">
          {count}
        </span>
      )}
      <button
        type="button"
        onClick={onCreate}
        title={t('history.createLabel')}
        aria-label={t('history.createLabel')}
        className="ml-auto flex cursor-pointer items-center gap-1 rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2 py-1 text-[10px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:bg-[var(--color-accent)]/30"
      >
        <Plus size={11} />
        {t('history.submit')}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('history.close')}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ====== Timeline scrubber ======

function TimelineStrip({
  labels,
  selectedId,
  onSelect,
}: {
  labels: HistoryLabelDTO[];
  selectedId: string | null;
  onSelect: (l: HistoryLabelDTO) => void;
}): ReactElement {
  const sorted = useMemo(
    () => [...labels].sort((a, b) => a.createdAt - b.createdAt),
    [labels]
  );
  const minTs = sorted[0].createdAt;
  const maxTs = sorted[sorted.length - 1].createdAt;
  const span = Math.max(1, maxTs - minTs);

  return (
    <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-3 py-2">
      <div className="relative h-6">
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-[var(--color-border-subtle)]"
        />
        {sorted.map((l) => {
          const pct = ((l.createdAt - minTs) / span) * 100;
          const color = kindColor(l.kind);
          const isSelected = l.id === selectedId;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onSelect(l)}
              title={`${l.name} · ${new Date(l.createdAt).toLocaleString()}`}
              aria-label={l.name}
              className={
                'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full p-0 transition-shadow hover:ring-2 focus:outline-none focus:ring-2 ' +
                (isSelected ? 'ring-2' : 'ring-0')
              }
              style={{
                left: `${pct}%`,
                width: isSelected ? 12 : 10,
                height: isSelected ? 12 : 10,
                backgroundColor: color,
                ['--tw-ring-color' as string]: color,
                ['--tw-ring-offset-color' as string]: 'var(--color-bg-primary)',
                ['--tw-ring-offset-width' as string]: '2px',
              }}
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

// ====== Labels list pane ======

function LabelListPane({
  labels,
  listError,
  listLoading,
  selectedId,
  onSelect,
  t,
}: {
  labels: HistoryLabelDTO[];
  listError: string | null;
  listLoading: boolean;
  selectedId: string | null;
  onSelect: (l: HistoryLabelDTO) => void;
  t: T;
}): ReactElement {
  return (
    <div className="flex w-[35%] min-w-[220px] flex-col overflow-y-auto bg-[var(--color-bg-primary)]/40">
      {listLoading && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          <Loader2 size={12} className="motion-safe:animate-spin" />
          {t('history.labelCreating')}
        </div>
      )}
      {listError === 'labelNoProject' && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
          {t('history.labelNoProject')}
        </div>
      )}
      {listError && listError !== 'labelNoProject' && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--color-error)]" role="alert">
          {listError}
        </div>
      )}
      {!listLoading && !listError && labels.length === 0 && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
          {t('history.labelEmpty')}
        </div>
      )}
      <ul className="flex-1">
        {labels.map((l) => {
          const isSelected = l.id === selectedId;
          return (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onSelect(l)}
                aria-current={isSelected ? 'true' : undefined}
                className={
                  'relative flex w-full cursor-pointer items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors focus:outline-none ' +
                  (isSelected
                    ? 'border-l-[var(--color-accent)] bg-[var(--color-accent-muted)]/40 '
                    : 'border-l-transparent hover:bg-[var(--color-bg-hover)] focus-visible:bg-[var(--color-bg-hover)]')
                }
              >
                <Tag
                  size={11}
                  className="mt-0.5 flex-shrink-0"
                  style={{ color: kindColor(l.kind) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
                      {l.name}
                    </span>
                    <KindChip kind={l.kind} t={t} />
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
                    {new Date(l.createdAt).toLocaleString()}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ====== Empty state ======

function EmptyState({ t }: { t: T }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Inbox size={32} className="text-[var(--color-text-muted)] opacity-40" />
      <p className="text-[11px] text-[var(--color-text-muted)]">
        {t('history.labelSelectPrompt')}
      </p>
      <p className="text-[10px] text-[var(--color-text-muted)] opacity-60">
        {t('history.labelKeyboardHint')}
      </p>
    </div>
  );
}

// ====== Label detail pane ======

function LabelDetailPane({
  label,
  detail,
  detailLoading,
  restore,
  onRestore,
  onViewDiff,
  t,
}: {
  label: HistoryLabelDTO;
  detail: DetailData | null;
  detailLoading: boolean;
  restore: RestoreState;
  onRestore: () => void;
  onViewDiff: (f: FileDiff) => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  const files = detail?.files ?? [];
  const totalAdded = files.reduce((acc, f) => acc + (f.stats?.added ?? 0), 0);
  const totalRemoved = files.reduce((acc, f) => acc + (f.stats?.removed ?? 0), 0);
  const hasChanges = totalAdded > 0 || totalRemoved > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
            {label.name}
          </span>
          <KindChip kind={label.kind} t={t} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
          <span>{new Date(label.createdAt).toLocaleString()}</span>
          <span>·</span>
          <span>{t('history.labelFilesCount', { count: files.length })}</span>
          {hasChanges && (
            <>
              <span>·</span>
              <span className="text-[var(--color-success)]">+{totalRemoved}</span>
              <span>/</span>
              <span className="text-[var(--color-error)]">-{totalAdded}</span>
            </>
          )}
        </div>
        {label.description && (
          <div className="mt-1.5 rounded bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
            {label.description}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {detailLoading && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <Loader2 size={12} className="motion-safe:animate-spin" />
            {t('history.labelCreating')}
          </div>
        )}
        {!detailLoading && detail?.error && (
          <div className="text-[11px] text-[var(--color-error)]" role="alert">
            {detail.error}
          </div>
        )}
        {!detailLoading && !detail?.error && (
          <ul className="space-y-0.5 font-mono text-[10px]">
            {files.map((f) => (
              <HistoryFileRow key={f.fileId} file={f} onViewDiff={onViewDiff} t={t} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-3 py-2">
        {restore.kind === 'done' && (
          <span className="text-[11px] text-[var(--color-success)]" role="status">
            {t('history.restoreSuccess', { count: restore.count })}
          </span>
        )}
        {restore.kind === 'error' && (
          <span className="text-[11px] text-[var(--color-error)]" role="alert">
            {t('history.restoreFailed', { error: restore.message })}
          </span>
        )}
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring}
          className="ml-auto flex cursor-pointer items-center gap-1 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-warning)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:ring-offset-1 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {restoring ? (
            <Loader2 size={11} className="motion-safe:animate-spin" />
          ) : (
            <RotateCcw size={11} />
          )}
          {restoring ? t('history.restoring') : t('history.restore')}
        </button>
      </div>
    </div>
  );
}

// ====== KindChip ======

function KindChip({ kind, t }: { kind: HistoryLabelDTO['kind']; t: T }): ReactElement {
  const color = kindColor(kind);
  const key: TranslationKey =
    kind === 'manual'
      ? 'history.labelKindManual'
      : kind === 'milestone'
        ? 'history.labelKindMilestone'
        : 'history.labelKindAuto';
  return (
    <span
      className="rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider"
      style={{
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
        color,
      }}
    >
      {t(key)}
    </span>
  );
}

function kindColor(kind: HistoryLabelDTO['kind']): string {
  switch (kind) {
    case 'manual':
      return 'var(--color-accent)';
    case 'milestone':
      return 'var(--color-warning)';
    default:
      return 'var(--color-text-muted)';
  }
}
