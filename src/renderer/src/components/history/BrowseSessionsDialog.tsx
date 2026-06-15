/**
 * @file BrowseSessionsDialog — git-log style browser for the L2 Step DAG.
 *
 * Three nested views in one dialog:
 *   sessions   → list every chat thread that recorded ≥1 SNACA-tool step
 *   steps      → for a picked session, list every step (most recent first)
 *   stepDetail → for a picked step, file list + per-file diff stats + Restore
 *
 * Restore at step level applies that step's `tree` snapshot to currently open
 * tabs (same handshake as label Restore: write + setContentFromExternal +
 * Overleaf sync). The view preserves a back-stack so Esc unwinds one level.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Bot,
  Eye,
  GitCommit,
  Loader2,
  MessagesSquare,
  RotateCcw,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { api, type HistoryStepDTO } from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useTranslation, type TranslationKey } from '../../locales';
import { getEditorService, getProjectRuntimeContext } from '../../services/core';
import { historyUIBus } from '../../services/core/HistoryUIBus';
import { historyProjectIdOf } from '../../utils/historyProjectId';
import { applySnapshotToOpenTabs } from '../../utils/historyRestore';
import { lineDiffStats } from '../../utils/lineDiffStats';
import { FileDiffOverlay } from './FileDiffOverlay';

interface SessionSummary {
  sessionId: string;
  chatThreadId: string | null;
  stepCount: number;
  lastTs: number;
}

interface StepFile {
  fileId: string;
  beforeText: string;
  afterText: string | null;
  stats: { added: number; removed: number } | null;
}

interface StepCause {
  /** Stable key for React lists — assigned at parse time. */
  id: string;
  toolName: string;
  argsJson?: string;
  resultSummary?: string;
}

type View =
  | { kind: 'sessions'; rows: SessionSummary[] | null; error: string | null }
  | { kind: 'steps'; session: SessionSummary; rows: HistoryStepDTO[] | null; error: string | null }
  | {
      kind: 'stepDetail';
      session: SessionSummary;
      step: HistoryStepDTO;
      files: StepFile[] | null;
      causes: StepCause[];
      error: string | null;
    };

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function BrowseSessionsDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'sessions', rows: null, error: null });
  const [loading, setLoading] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' });
  const [diffViewFile, setDiffViewFile] = useState<StepFile | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, isOpen);

  const loadSessions = useCallback(async (): Promise<void> => {
    const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
    if (!projectId) {
      setView({ kind: 'sessions', rows: [], error: 'labelNoProject' });
      return;
    }
    setLoading(true);
    try {
      const rows = await api.history.listSessions({ projectId, limit: 200 });
      setView({ kind: 'sessions', rows, error: null });
    } catch (e) {
      setView({ kind: 'sessions', rows: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const disposable = historyUIBus.onOpenBrowseSessions(() => {
      setIsOpen(true);
      setRestore({ kind: 'idle' });
      void loadSessions();
    });
    return () => disposable.dispose();
  }, [loadSessions]);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => containerRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  const close = useCallback(() => setIsOpen(false), []);

  const openSession = useCallback(async (session: SessionSummary): Promise<void> => {
    setView({ kind: 'steps', session, rows: null, error: null });
    setLoading(true);
    try {
      const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
      const rows = await api.history.listSessionSteps({
        projectId,
        sessionId: session.sessionId,
        limit: 500,
      });
      // Newest-first like git log.
      rows.sort((a, b) => b.ts - a.ts);
      setView({ kind: 'steps', session, rows, error: null });
    } catch (e) {
      setView({
        kind: 'steps',
        session,
        rows: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const openStep = useCallback(
    async (session: SessionSummary, step: HistoryStepDTO): Promise<void> => {
      setView({
        kind: 'stepDetail',
        session,
        step,
        files: null,
        causes: parseCauses(step.causes),
        error: null,
      });
      setLoading(true);
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const stepHashHex = bytesToHex(step.hash);
        const snapshot = await api.history.resolveStepSnapshot({
          projectId,
          hashHex: stepHashHex,
        });
        const tabs = getEditorService().tabs;
        const decoder = new TextDecoder();
        const files: StepFile[] = Object.keys(snapshot)
          .sort()
          .map((fileId) => {
            const bytes = snapshot[fileId];
            const beforeText = decoder.decode(bytes);
            const tab = tabs.find((tt) => tt._id === fileId || tt.path === fileId);
            if (!tab) return { fileId, beforeText, afterText: null, stats: null };
            return {
              fileId,
              beforeText,
              afterText: tab.content,
              stats: lineDiffStats(beforeText, tab.content),
            };
          });
        setView({
          kind: 'stepDetail',
          session,
          step,
          files,
          causes: parseCauses(step.causes),
          error: null,
        });
      } catch (e) {
        setView({
          kind: 'stepDetail',
          session,
          step,
          files: null,
          causes: parseCauses(step.causes),
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const back = useCallback(() => {
    if (view.kind === 'stepDetail') {
      void openSession(view.session);
      setRestore({ kind: 'idle' });
    } else if (view.kind === 'steps') {
      setView({ kind: 'sessions', rows: null, error: null });
      void loadSessions();
    }
  }, [view, openSession, loadSessions]);

  const doRestoreStep = useCallback(
    async (step: HistoryStepDTO): Promise<void> => {
      const ok = await api.dialog.confirm(
        t('history.rollbackBeforeConfirm'),
        t('history.rollbackBeforeTitle')
      );
      if (!ok) return;
      setRestore({ kind: 'restoring' });
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const snapshot = await api.history.resolveStepSnapshot({
          projectId,
          hashHex: bytesToHex(step.hash),
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
    },
    [t]
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (view.kind === 'sessions') close();
      else back();
    },
    [view.kind, close, back]
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t('history.browseSessions')}
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
            className="flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg focus:outline-none"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <Header view={view} onBack={back} onClose={close} t={t} />
            <div className="flex-1 overflow-y-auto px-3 py-2 text-[12px]">
              {loading && (
                <div className="flex items-center gap-1.5 py-2 text-[11px] text-[var(--color-text-muted)]">
                  <Loader2 size={12} className="motion-safe:animate-spin" />
                  {t('history.labelCreating')}
                </div>
              )}
              {view.kind === 'sessions' && !loading && (
                <SessionsView view={view} onPick={openSession} t={t} />
              )}
              {view.kind === 'steps' && !loading && (
                <StepsView view={view} onPick={(step) => void openStep(view.session, step)} t={t} />
              )}
              {view.kind === 'stepDetail' && !loading && (
                <StepDetailView
                  view={view}
                  restore={restore}
                  onRestore={() => void doRestoreStep(view.step)}
                  onViewDiff={(f) => setDiffViewFile(f)}
                  t={t}
                />
              )}
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

// ---------- Header ----------

function Header({
  view,
  onBack,
  onClose,
  t,
}: {
  view: View;
  onBack: () => void;
  onClose: () => void;
  t: T;
}): ReactElement {
  const title =
    view.kind === 'sessions'
      ? t('history.browseSessions')
      : view.kind === 'steps'
        ? sessionLabel(view.session, t)
        : `${sessionLabel(view.session, t)} · ${stepLabelShort(view.step)}`;
  return (
    <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-2">
      {view.kind === 'sessions' ? (
        <MessagesSquare size={14} className="text-[var(--color-accent)]" />
      ) : (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('history.close')}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <ArrowLeft size={14} />
        </button>
      )}
      <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        {title}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('history.close')}
        className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ---------- Sessions list ----------

function SessionsView({
  view,
  onPick,
  t,
}: {
  view: Extract<View, { kind: 'sessions' }>;
  onPick: (s: SessionSummary) => void;
  t: T;
}): ReactElement {
  const rows = view.rows ?? [];
  if (view.error === 'labelNoProject') {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-text-muted)]">
        {t('history.labelNoProject')}
      </div>
    );
  }
  if (view.error) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-error)]" role="alert">
        {view.error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-text-muted)]">
        {t('history.sessionsEmpty')}
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {rows.map((s) => (
        <li key={s.sessionId}>
          <button
            type="button"
            onClick={() => onPick(s)}
            className="flex w-full cursor-pointer items-start gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-left transition-colors hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-bg-hover)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] active:bg-[var(--color-bg-tertiary)]"
          >
            {s.chatThreadId ? (
              <Bot size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-accent)]" />
            ) : (
              <Users size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-text-muted)]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
                {sessionLabel(s, t)}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
                <span>{t('history.sessionsStepCount', { count: s.stepCount })}</span>
                <span>·</span>
                <span>{new Date(s.lastTs).toLocaleString()}</span>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------- Steps list ----------

function StepsView({
  view,
  onPick,
  t,
}: {
  view: Extract<View, { kind: 'steps' }>;
  onPick: (step: HistoryStepDTO) => void;
  t: T;
}): ReactElement {
  const rows = view.rows ?? [];
  if (view.error) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-error)]" role="alert">
        {view.error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="py-4 text-center text-[11px] text-[var(--color-text-muted)]">
        {t('history.stepsEmpty')}
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {rows.map((s) => {
        const causes = parseCauses(s.causes);
        const primary = causes[0];
        return (
          <li key={bytesToHex(s.hash)}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="flex w-full cursor-pointer items-start gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-left transition-colors hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-bg-hover)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] active:bg-[var(--color-bg-tertiary)]"
            >
              <OriginIcon origin={s.origin} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
                    {primary?.toolName ?? s.origin}
                  </span>
                  <OriginChip origin={s.origin} t={t} />
                </div>
                {primary?.resultSummary && (
                  <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                    {primary.resultSummary}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
                  <span>{new Date(s.ts).toLocaleString()}</span>
                  {s.sizeDelta > 0 && (
                    <>
                      <span>·</span>
                      <span>Δ {s.sizeDelta}B</span>
                    </>
                  )}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- Step detail ----------

function StepDetailView({
  view,
  restore,
  onRestore,
  onViewDiff,
  t,
}: {
  view: Extract<View, { kind: 'stepDetail' }>;
  restore: RestoreState;
  onRestore: () => void;
  onViewDiff: (f: StepFile) => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  const files = view.files ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <OriginChip origin={view.step.origin} t={t} />
        <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
          {new Date(view.step.ts).toLocaleString()}
        </span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
          {t('history.labelFilesCount', { count: files.length })}
        </span>
      </div>
      {view.causes.length > 0 && (
        <ul className="space-y-1 rounded bg-[var(--color-bg-primary)] p-1.5 text-[11px]">
          {view.causes.map((c) => (
            <li key={c.id}>
              <div className="flex items-center gap-1.5">
                <Sparkles size={10} className="flex-shrink-0 text-[var(--color-accent)]" />
                <span className="truncate font-mono text-[11px] text-[var(--color-text-primary)]">
                  {c.toolName}
                </span>
              </div>
              {c.resultSummary && (
                <div className="ml-4 text-[10px] text-[var(--color-text-muted)]">
                  {c.resultSummary}
                </div>
              )}
              {c.argsJson && (
                <pre className="ml-4 mt-0.5 max-h-16 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-tertiary)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-text-muted)]">
                  {c.argsJson}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.error && (
        <div className="text-[10px] text-[var(--color-error)]" role="alert">
          {view.error}
        </div>
      )}
      <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-1 font-mono text-[10px]">
        {files.map((f) => {
          const viewable = f.stats !== null && (f.stats.added > 0 || f.stats.removed > 0);
          return (
            <li
              key={f.fileId}
              className="group flex items-center gap-1.5 truncate px-1 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
            >
              <span className="min-w-0 flex-1 truncate">{f.fileId}</span>
              {f.stats === null ? (
                <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
                  {t('history.diffStatsClosed')}
                </span>
              ) : f.stats.added === 0 && f.stats.removed === 0 ? (
                <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
                  {t('history.diffStatsNoChange')}
                </span>
              ) : (
                <span className="flex-shrink-0 tabular-nums">
                  <span className="text-[var(--color-success)]">+{f.stats.removed}</span>
                  <span className="px-0.5 text-[var(--color-text-muted)]">/</span>
                  <span className="text-[var(--color-error)]">-{f.stats.added}</span>
                </span>
              )}
              {viewable && (
                <button
                  type="button"
                  onClick={() => onViewDiff(f)}
                  title={t('history.viewDiff')}
                  aria-label={t('history.viewDiff')}
                  className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100"
                >
                  <Eye size={11} />
                </button>
              )}
            </li>
          );
        })}
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
          className="flex cursor-pointer items-center gap-1 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-warning)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:ring-offset-1 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
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

// ---------- helpers ----------

function OriginChip({
  origin,
  t,
}: {
  origin: HistoryStepDTO['origin'];
  t: T;
}): ReactElement {
  const map = {
    snaca_tool: { key: 'history.originSnaca', color: 'var(--color-accent)' },
    human_edit: { key: 'history.originHuman', color: 'var(--color-text-muted)' },
    merge: { key: 'history.originMerge', color: 'var(--color-warning)' },
  } as const;
  const entry = map[origin];
  return (
    <span
      className="rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider"
      style={{
        borderColor: `color-mix(in srgb, ${entry.color} 50%, transparent)`,
        color: entry.color,
      }}
    >
      {t(entry.key)}
    </span>
  );
}

function OriginIcon({ origin }: { origin: HistoryStepDTO['origin'] }): ReactElement {
  if (origin === 'snaca_tool')
    return <Bot size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-accent)]" />;
  if (origin === 'merge')
    return <GitCommit size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-warning)]" />;
  return <Users size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-text-muted)]" />;
}

function sessionLabel(s: SessionSummary, t: T): string {
  if (s.chatThreadId) {
    return t('history.sessionChat', { thread: s.chatThreadId.slice(0, 12) });
  }
  return t('history.sessionLocal');
}

function stepLabelShort(step: HistoryStepDTO): string {
  const causes = parseCauses(step.causes);
  return causes[0]?.toolName ?? step.origin;
}

/** Decode the `causes` bytes column (JSON-encoded array of {toolName,...}). */
function parseCauses(bytes: Uint8Array): StepCause[] {
  if (!bytes || bytes.length === 0) return [];
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is Omit<StepCause, 'id'> =>
          c && typeof c === 'object' && typeof c.toolName === 'string'
      )
      .map((c, i) => ({ ...c, id: `${i}-${c.toolName}` }));
  } catch {
    return [];
  }
}

function bytesToHex(bs: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bs.length; i++) out += bs[i].toString(16).padStart(2, '0');
  return out;
}
