/**
 * @file BrowseSessionsDialog - split-panel git-log over the L2 Step DAG.
 *
 * Layout (GitLens-inspired, three structural regions in two physical panes):
 *   ┌──────────────────────────────────────────────────┐
 *   │ header              session dropdown ▼      [×]  │
 *   ├──────────────┬───────────────────────────────────┤
 *   │ steps list   │ step detail                       │
 *   │   ~38%       │   ~62%                            │
 *   │ scroll       │ causes + files + diff + restore   │
 *   └──────────────┴───────────────────────────────────┘
 *
 * Why this shape, not master-detail-detail (three columns)?
 * - Most projects have <10 sessions; a dedicated 20% column wastes the
 *   horizontal real estate that the diff column desperately needs.
 * - A `<select>` for sessions keeps the switcher one click away and frees
 *   the canvas for the actual content (steps + detail).
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  Eye,
  GitCommit,
  Inbox,
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
  useMemo,
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
  id: string;
  toolName: string;
  argsJson?: string;
  resultSummary?: string;
}

interface StepDetailData {
  files: StepFile[];
  causes: StepCause[];
  error: string | null;
}

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function BrowseSessionsDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [steps, setSteps] = useState<HistoryStepDTO[] | null>(null);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [selectedStepHashHex, setSelectedStepHashHex] = useState<string | null>(null);
  const [stepDetail, setStepDetail] = useState<StepDetailData | null>(null);
  const [stepDetailLoading, setStepDetailLoading] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' });
  const [diffViewFile, setDiffViewFile] = useState<StepFile | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, isOpen);

  const loadSessions = useCallback(async (): Promise<void> => {
    const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
    if (!projectId) {
      setSessions([]);
      setSessionError('labelNoProject');
      return;
    }
    setSessionError(null);
    try {
      const rows = await api.history.listSessions({ projectId, limit: 200 });
      setSessions(rows);
      if (rows.length > 0 && selectedSessionId === null) {
        setSelectedSessionId(rows[0].sessionId);
      }
    } catch (e) {
      setSessions([]);
      setSessionError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedSessionId]);

  useEffect(() => {
    const disposable = historyUIBus.onOpenBrowseSessions(() => {
      setIsOpen(true);
      setSelectedSessionId(null);
      setSelectedStepHashHex(null);
      setSteps(null);
      setStepDetail(null);
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

  // Load steps when the selected session changes.
  useEffect(() => {
    if (!selectedSessionId) {
      setSteps(null);
      setSelectedStepHashHex(null);
      return;
    }
    let cancelled = false;
    setSteps(null);
    setStepsLoading(true);
    setSelectedStepHashHex(null);
    setStepDetail(null);
    (async () => {
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const rows = await api.history.listSessionSteps({
          projectId,
          sessionId: selectedSessionId,
          limit: 500,
        });
        rows.sort((a, b) => b.ts - a.ts);
        if (cancelled) return;
        setSteps(rows);
        // Auto-select the most recent step so the right pane is never blank.
        if (rows.length > 0) {
          setSelectedStepHashHex(bytesToHex(rows[0].hash));
        }
      } catch {
        if (cancelled) return;
        setSteps([]);
      } finally {
        if (!cancelled) setStepsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  const selectedStep = useMemo<HistoryStepDTO | null>(() => {
    if (!steps || !selectedStepHashHex) return null;
    return steps.find((s) => bytesToHex(s.hash) === selectedStepHashHex) ?? null;
  }, [steps, selectedStepHashHex]);

  // Resolve the selected step's tree → file diffs.
  useEffect(() => {
    if (!selectedStep) {
      setStepDetail(null);
      setRestore({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setStepDetail(null);
    setStepDetailLoading(true);
    setRestore({ kind: 'idle' });
    const causes = parseCauses(selectedStep.causes);
    (async () => {
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const snapshot = await api.history.resolveStepSnapshot({
          projectId,
          hashHex: bytesToHex(selectedStep.hash),
        });
        if (cancelled) return;
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
        setStepDetail({ files, causes, error: null });
      } catch (e) {
        if (cancelled) return;
        setStepDetail({
          files: [],
          causes,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!cancelled) setStepDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStep]);

  const close = useCallback(() => setIsOpen(false), []);

  const doRestoreStep = useCallback(async (): Promise<void> => {
    if (!selectedStep) return;
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
        hashHex: bytesToHex(selectedStep.hash),
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
  }, [selectedStep, t]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (!steps || steps.length === 0) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = selectedStepHashHex
          ? steps.findIndex((s) => bytesToHex(s.hash) === selectedStepHashHex)
          : -1;
        const next = steps[Math.min(idx + 1, steps.length - 1)];
        if (next) setSelectedStepHashHex(bytesToHex(next.hash));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = selectedStepHashHex
          ? steps.findIndex((s) => bytesToHex(s.hash) === selectedStepHashHex)
          : 0;
        const next = steps[Math.max(idx - 1, 0)];
        if (next) setSelectedStepHashHex(bytesToHex(next.hash));
      }
    },
    [close, steps, selectedStepHashHex]
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
            className="flex h-[78vh] w-[min(1040px,95vw)] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl focus:outline-none"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <Header
              sessions={sessions ?? []}
              selectedSessionId={selectedSessionId}
              onSelectSession={setSelectedSessionId}
              onClose={close}
              t={t}
            />

            <div className="flex min-h-0 flex-1">
              <StepListPane
                steps={steps ?? []}
                stepsLoading={stepsLoading}
                sessionError={sessionError}
                selectedHashHex={selectedStepHashHex}
                onSelect={(s) => setSelectedStepHashHex(bytesToHex(s.hash))}
                t={t}
              />
              <div className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--color-border-subtle)]">
                {!selectedStep ? (
                  <EmptyState t={t} />
                ) : (
                  <StepDetailPane
                    step={selectedStep}
                    detail={stepDetail}
                    loading={stepDetailLoading}
                    restore={restore}
                    onRestore={() => void doRestoreStep()}
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

// ====== Header with session dropdown ======

function Header({
  sessions,
  selectedSessionId,
  onSelectSession,
  onClose,
  t,
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onClose: () => void;
  t: T;
}): ReactElement {
  const sessionOptions = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.sessionId,
        label: `${sessionLabel(s, t)} · ${t('history.sessionsStepCount', { count: s.stepCount })} · ${new Date(s.lastTs).toLocaleString()}`,
      })),
    [sessions, t]
  );
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <MessagesSquare size={14} className="flex-shrink-0 text-[var(--color-accent)]" />
      <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        {t('history.browseSessions')}
      </span>
      {sessions.length > 0 ? (
        <select
          aria-label={t('history.browseSessions')}
          value={selectedSessionId ?? ''}
          onChange={(e) => onSelectSession(e.target.value)}
          className="min-w-0 flex-1 cursor-pointer truncate rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          {sessionOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {t('history.sessionsEmpty')}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={t('history.close')}
        className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ====== Step list pane ======

function StepListPane({
  steps,
  stepsLoading,
  sessionError,
  selectedHashHex,
  onSelect,
  t,
}: {
  steps: HistoryStepDTO[];
  stepsLoading: boolean;
  sessionError: string | null;
  selectedHashHex: string | null;
  onSelect: (step: HistoryStepDTO) => void;
  t: T;
}): ReactElement {
  return (
    <div className="flex w-[38%] min-w-[240px] flex-col overflow-y-auto bg-[var(--color-bg-primary)]/40">
      {stepsLoading && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          <Loader2 size={12} className="motion-safe:animate-spin" />
          {t('history.labelCreating')}
        </div>
      )}
      {sessionError === 'labelNoProject' && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
          {t('history.labelNoProject')}
        </div>
      )}
      {!stepsLoading && !sessionError && steps.length === 0 && (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
          {t('history.stepsEmpty')}
        </div>
      )}
      <ul className="flex-1">
        {steps.map((s) => {
          const hex = bytesToHex(s.hash);
          const isSelected = hex === selectedHashHex;
          const causes = parseCauses(s.causes);
          const primary = causes[0];
          return (
            <li key={hex}>
              <button
                type="button"
                onClick={() => onSelect(s)}
                aria-current={isSelected ? 'true' : undefined}
                className={
                  'flex w-full cursor-pointer items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors focus:outline-none ' +
                  (isSelected
                    ? 'border-l-[var(--color-accent)] bg-[var(--color-accent-muted)]/40 '
                    : 'border-l-transparent hover:bg-[var(--color-bg-hover)] focus-visible:bg-[var(--color-bg-hover)]')
                }
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
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
                    {new Date(s.ts).toLocaleString()}
                    {s.sizeDelta > 0 && ` · Δ ${s.sizeDelta}B`}
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
        {t('history.stepSelectPrompt')}
      </p>
      <p className="text-[10px] text-[var(--color-text-muted)] opacity-60">
        {t('history.labelKeyboardHint')}
      </p>
    </div>
  );
}

// ====== Step detail pane ======

function StepDetailPane({
  step,
  detail,
  loading,
  restore,
  onRestore,
  onViewDiff,
  t,
}: {
  step: HistoryStepDTO;
  detail: StepDetailData | null;
  loading: boolean;
  restore: RestoreState;
  onRestore: () => void;
  onViewDiff: (f: StepFile) => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  const files = detail?.files ?? [];
  const causes = detail?.causes ?? [];
  const totalAdded = files.reduce((acc, f) => acc + (f.stats?.added ?? 0), 0);
  const totalRemoved = files.reduce((acc, f) => acc + (f.stats?.removed ?? 0), 0);
  const hasChanges = totalAdded > 0 || totalRemoved > 0;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <OriginIcon origin={step.origin} />
          <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
            {causes[0]?.toolName ?? step.origin}
          </span>
          <OriginChip origin={step.origin} t={t} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
          <span>{new Date(step.ts).toLocaleString()}</span>
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
          {step.sizeDelta > 0 && (
            <>
              <span>·</span>
              <span>Δ {step.sizeDelta}B</span>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px]">
        {loading && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <Loader2 size={12} className="motion-safe:animate-spin" />
            {t('history.labelCreating')}
          </div>
        )}
        {!loading && detail?.error && (
          <div className="text-[11px] text-[var(--color-error)]" role="alert">
            {detail.error}
          </div>
        )}
        {!loading && causes.length > 0 && (
          <ul className="mb-2 space-y-1 rounded bg-[var(--color-bg-primary)] p-1.5 text-[11px]">
            {causes.map((c) => (
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
        {!loading && (
          <ul className="space-y-0.5 font-mono text-[10px]">
            {files.map((f) => (
              <FileRow key={f.fileId} file={f} onViewDiff={onViewDiff} t={t} />
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

function FileRow({
  file,
  onViewDiff,
  t,
}: {
  file: StepFile;
  onViewDiff: (f: StepFile) => void;
  t: T;
}): ReactElement {
  const viewable = file.stats !== null && (file.stats.added > 0 || file.stats.removed > 0);
  return (
    <li className="group flex items-center gap-1.5 truncate rounded px-1 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
      <span className="min-w-0 flex-1 truncate">{file.fileId}</span>
      {file.stats === null ? (
        <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
          {t('history.diffStatsClosed')}
        </span>
      ) : file.stats.added === 0 && file.stats.removed === 0 ? (
        <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
          {t('history.diffStatsNoChange')}
        </span>
      ) : (
        <span className="flex-shrink-0 tabular-nums">
          <span className="text-[var(--color-success)]">+{file.stats.removed}</span>
          <span className="px-0.5 text-[var(--color-text-muted)]">/</span>
          <span className="text-[var(--color-error)]">-{file.stats.added}</span>
        </span>
      )}
      {viewable && (
        <button
          type="button"
          onClick={() => onViewDiff(file)}
          title={t('history.viewDiff')}
          aria-label={t('history.viewDiff')}
          className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100"
        >
          <Eye size={11} />
        </button>
      )}
    </li>
  );
}

// ====== Origin helpers ======

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

// ====== Helpers ======

function sessionLabel(s: SessionSummary, t: T): string {
  if (s.chatThreadId) {
    return t('history.sessionChat', { thread: s.chatThreadId.slice(0, 12) });
  }
  return t('history.sessionLocal');
}

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
