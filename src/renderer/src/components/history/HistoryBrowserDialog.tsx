/**
 * @file HistoryBrowserDialog - unified browser for labels + sessions.
 *
 * Replaces BrowseLabelsDialog + BrowseSessionsDialog with one dialog that
 * hosts a top tab strip [Labels | Sessions] over a single split-panel body.
 *
 * Rationale:
 * - Two separate modals fragmented the mental model — users had to remember
 *   which sidebar button opened which surface.
 * - Sharing the chrome (header, escape handler, focus trap, framer-motion
 *   entry) lets us tune one place.
 * - Tab switch preserves each side's state (selected label / selected
 *   session / selected step) so users can flick between the two without
 *   losing context.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  FolderOpen,
  GitCommit,
  Inbox,
  Loader2,
  MessagesSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Tag,
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
import { api, type HistoryLabelDTO, type HistoryStepDTO } from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useTranslation, type TranslationKey } from '../../locales';
import { getEditorService, getProjectRuntimeContext } from '../../services/core';
import { historyUIBus, type HistoryBrowserTab } from '../../services/core/HistoryUIBus';
import { historyProjectIdOf } from '../../utils/historyProjectId';
import { applySnapshotToOpenTabs } from '../../utils/historyRestore';
import { lineDiffStats } from '../../utils/lineDiffStats';
import { FileDiffOverlay } from './FileDiffOverlay';
import { HistoryFileRow, type HistoryFileSnapshot } from './HistoryFileRow';

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

// ----- Labels-tab state -----

interface LabelsState {
  labels: HistoryLabelDTO[] | null;
  listError: string | null;
  listLoading: boolean;
  selectedId: string | null;
  detail: { files: HistoryFileSnapshot[]; error: string | null } | null;
  detailLoading: boolean;
  restore: RestoreState;
}

const INITIAL_LABELS_STATE: LabelsState = {
  labels: null,
  listError: null,
  listLoading: false,
  selectedId: null,
  detail: null,
  detailLoading: false,
  restore: { kind: 'idle' },
};

// ----- Sessions-tab state -----

interface SessionSummary {
  sessionId: string;
  chatThreadId: string | null;
  stepCount: number;
  lastTs: number;
}

interface StepCause {
  id: string;
  toolName: string;
  argsJson?: string;
  resultSummary?: string;
}

interface SessionsState {
  sessions: SessionSummary[] | null;
  sessionError: string | null;
  selectedSessionId: string | null;
  steps: HistoryStepDTO[] | null;
  stepsLoading: boolean;
  selectedStepHashHex: string | null;
  stepDetail: { files: HistoryFileSnapshot[]; causes: StepCause[]; error: string | null } | null;
  stepDetailLoading: boolean;
  restore: RestoreState;
}

const INITIAL_SESSIONS_STATE: SessionsState = {
  sessions: null,
  sessionError: null,
  selectedSessionId: null,
  steps: null,
  stepsLoading: false,
  selectedStepHashHex: null,
  stepDetail: null,
  stepDetailLoading: false,
  restore: { kind: 'idle' },
};

// =============================================================
// Main dialog
// =============================================================

export function HistoryBrowserDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<HistoryBrowserTab>('labels');
  const [labelsState, setLabelsState] = useState<LabelsState>(INITIAL_LABELS_STATE);
  const [sessionsState, setSessionsState] = useState<SessionsState>(INITIAL_SESSIONS_STATE);
  const [diffViewFile, setDiffViewFile] = useState<HistoryFileSnapshot | null>(null);
  // Counter that the steps-loading effect depends on so a `sessionsChanged`
  // broadcast (e.g. a SNACA tool step just landed) refetches the steps list
  // for the currently-selected session WITHOUT having to deselect/reselect.
  // selectedSessionId stays stable, so we bump this counter as the explicit
  // invalidation signal.
  const [stepsReloadKey, setStepsReloadKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, isOpen);

  // ---- Bus subscription ----

  useEffect(() => {
    const disposable = historyUIBus.onOpenBrowser((tab) => {
      setIsOpen(true);
      setActiveTab(tab);
    });
    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => containerRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  // ---- Labels tab loader ----

  const loadLabels = useCallback(async (): Promise<void> => {
    const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
    if (!projectId) {
      setLabelsState((s) => ({ ...s, labels: [], listError: 'labelNoProject' }));
      return;
    }
    setLabelsState((s) => ({ ...s, listLoading: true, listError: null }));
    try {
      const rows = await api.history.listLabels({ projectId, limit: 200 });
      setLabelsState((s) => ({
        ...s,
        labels: rows,
        listLoading: false,
        selectedId: s.selectedId ?? rows[0]?.id ?? null,
      }));
    } catch (e) {
      setLabelsState((s) => ({
        ...s,
        labels: [],
        listLoading: false,
        listError: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  useEffect(() => {
    if (isOpen && activeTab === 'labels' && labelsState.labels === null) {
      void loadLabels();
    }
  }, [isOpen, activeTab, labelsState.labels, loadLabels]);

  const selectedLabel = useMemo<HistoryLabelDTO | null>(() => {
    if (!labelsState.labels || !labelsState.selectedId) return null;
    return labelsState.labels.find((l) => l.id === labelsState.selectedId) ?? null;
  }, [labelsState.labels, labelsState.selectedId]);

  useEffect(() => {
    if (!selectedLabel) {
      setLabelsState((s) => ({ ...s, detail: null, restore: { kind: 'idle' } }));
      return;
    }
    let cancelled = false;
    setLabelsState((s) => ({ ...s, detail: null, detailLoading: true, restore: { kind: 'idle' } }));
    (async () => {
      try {
        const map = await api.history.resolveLabelSnapshot({
          projectId: selectedLabel.projectId,
          labelId: selectedLabel.id,
        });
        if (cancelled) return;
        const files = snapshotToFiles(map);
        setLabelsState((s) => ({ ...s, detail: { files, error: null }, detailLoading: false }));
      } catch (e) {
        if (cancelled) return;
        setLabelsState((s) => ({
          ...s,
          detail: { files: [], error: e instanceof Error ? e.message : String(e) },
          detailLoading: false,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLabel]);

  // ---- Sessions tab loader ----

  const loadSessions = useCallback(async (): Promise<void> => {
    const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
    if (!projectId) {
      setSessionsState((s) => ({ ...s, sessions: [], sessionError: 'labelNoProject' }));
      return;
    }
    setSessionsState((s) => ({ ...s, sessionError: null }));
    try {
      const rows = await api.history.listSessions({ projectId, limit: 200 });
      setSessionsState((s) => ({
        ...s,
        sessions: rows,
        selectedSessionId: s.selectedSessionId ?? rows[0]?.sessionId ?? null,
      }));
    } catch (e) {
      setSessionsState((s) => ({
        ...s,
        sessions: [],
        sessionError: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  useEffect(() => {
    if (isOpen && activeTab === 'sessions' && sessionsState.sessions === null) {
      void loadSessions();
    }
  }, [isOpen, activeTab, sessionsState.sessions, loadSessions]);

  // Live invalidation — write sites (NewLabelDialog, AutoLabelScheduler,
  // ChatStreamStore.recordSnacaToolStep) fire on the bus; if the browser
  // is open we refetch the affected tab so freshly-saved data shows up
  // without the user having to close and reopen the dialog.
  //
  // `!isOpen` short-circuits because the dialog is always mounted (it
  // needs the openBrowser listener) but holds no UI when closed — no
  // need to refetch.
  useEffect(() => {
    if (!isOpen) return;
    const dLabels = historyUIBus.onLabelsChanged(() => {
      if (activeTab === 'labels') void loadLabels();
    });
    const dSessions = historyUIBus.onSessionsChanged(() => {
      if (activeTab === 'sessions') {
        void loadSessions();
        // Force the steps-load effect to re-run for the currently-selected
        // session — selectedSessionId is unchanged so we can't rely on a
        // dep-change to invalidate it.
        setStepsReloadKey((n) => n + 1);
      }
    });
    return () => {
      dLabels.dispose();
      dSessions.dispose();
    };
  }, [isOpen, activeTab, loadLabels, loadSessions]);

  useEffect(() => {
    if (!sessionsState.selectedSessionId) {
      setSessionsState((s) => ({ ...s, steps: null, selectedStepHashHex: null, stepDetail: null }));
      return;
    }
    const sessionId = sessionsState.selectedSessionId;
    let cancelled = false;
    setSessionsState((s) => ({
      ...s,
      steps: null,
      stepsLoading: true,
      selectedStepHashHex: null,
      stepDetail: null,
    }));
    (async () => {
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const rows = await api.history.listSessionSteps({
          projectId,
          sessionId,
          limit: 500,
        });
        rows.sort((a, b) => b.ts - a.ts);
        if (cancelled) return;
        setSessionsState((s) => ({
          ...s,
          steps: rows,
          stepsLoading: false,
          selectedStepHashHex: rows[0] ? bytesToHex(rows[0].hash) : null,
        }));
      } catch {
        if (cancelled) return;
        setSessionsState((s) => ({ ...s, steps: [], stepsLoading: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionsState.selectedSessionId, stepsReloadKey]);

  const selectedStep = useMemo<HistoryStepDTO | null>(() => {
    if (!sessionsState.steps || !sessionsState.selectedStepHashHex) return null;
    return (
      sessionsState.steps.find((s) => bytesToHex(s.hash) === sessionsState.selectedStepHashHex) ??
      null
    );
  }, [sessionsState.steps, sessionsState.selectedStepHashHex]);

  useEffect(() => {
    if (!selectedStep) {
      setSessionsState((s) => ({ ...s, stepDetail: null, restore: { kind: 'idle' } }));
      return;
    }
    let cancelled = false;
    setSessionsState((s) => ({
      ...s,
      stepDetail: null,
      stepDetailLoading: true,
      restore: { kind: 'idle' },
    }));
    const causes = parseCauses(selectedStep.causes);
    (async () => {
      try {
        const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
        const snapshot = await api.history.resolveStepSnapshot({
          projectId,
          hashHex: bytesToHex(selectedStep.hash),
        });
        if (cancelled) return;
        const files = snapshotToFiles(snapshot);
        setSessionsState((s) => ({
          ...s,
          stepDetail: { files, causes, error: null },
          stepDetailLoading: false,
        }));
      } catch (e) {
        if (cancelled) return;
        setSessionsState((s) => ({
          ...s,
          stepDetail: { files: [], causes, error: e instanceof Error ? e.message : String(e) },
          stepDetailLoading: false,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStep]);

  // ---- Restore handlers ----

  const close = useCallback(() => setIsOpen(false), []);

  const restoreLabel = useCallback(async (): Promise<void> => {
    if (!selectedLabel) return;
    const ok = await api.dialog.confirm(
      t('history.restoreConfirm', { name: selectedLabel.name }),
      t('history.restoreConfirmTitle')
    );
    if (!ok) return;
    setLabelsState((s) => ({ ...s, restore: { kind: 'restoring' } }));
    try {
      const snapshot = await api.history.resolveLabelSnapshot({
        projectId: selectedLabel.projectId,
        labelId: selectedLabel.id,
      });
      const { count } = await applySnapshotToOpenTabs(snapshot);
      setLabelsState((s) => ({ ...s, restore: { kind: 'done', count } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLabelsState((s) => ({
        ...s,
        restore: {
          kind: 'error',
          message: msg === 'no open tabs' ? t('history.restoreNoTabs') : msg,
        },
      }));
    }
  }, [selectedLabel, t]);

  const restoreStep = useCallback(async (): Promise<void> => {
    if (!selectedStep) return;
    const ok = await api.dialog.confirm(
      t('history.rollbackBeforeConfirm'),
      t('history.rollbackBeforeTitle')
    );
    if (!ok) return;
    setSessionsState((s) => ({ ...s, restore: { kind: 'restoring' } }));
    try {
      const projectId = historyProjectIdOf(getProjectRuntimeContext().rootPath);
      const snapshot = await api.history.resolveStepSnapshot({
        projectId,
        hashHex: bytesToHex(selectedStep.hash),
      });
      const { count } = await applySnapshotToOpenTabs(snapshot);
      setSessionsState((s) => ({ ...s, restore: { kind: 'done', count } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSessionsState((s) => ({
        ...s,
        restore: {
          kind: 'error',
          message: msg === 'no open tabs' ? t('history.restoreNoTabs') : msg,
        },
      }));
    }
  }, [selectedStep, t]);

  // ---- Keyboard ----

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // Ctrl/Cmd+1 / Ctrl/Cmd+2 swap tabs — same chord as Chrome.
      if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setActiveTab(e.key === '1' ? 'labels' : 'sessions');
        return;
      }
      if (activeTab === 'labels' && labelsState.labels && labelsState.labels.length > 0) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveLabelSelection(labelsState, setLabelsState, +1);
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveLabelSelection(labelsState, setLabelsState, -1);
        }
      } else if (activeTab === 'sessions' && sessionsState.steps && sessionsState.steps.length > 0) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveStepSelection(sessionsState, setSessionsState, +1);
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveStepSelection(sessionsState, setSessionsState, -1);
        }
      }
    },
    [activeTab, close, labelsState, sessionsState]
  );

  // ---- Render ----

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t('history.browserTitle')}
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
            className="flex h-[80vh] w-[min(1080px,95vw)] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl focus:outline-none"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <TabHeader
              activeTab={activeTab}
              labelsCount={labelsState.labels?.length ?? 0}
              sessionsCount={sessionsState.sessions?.length ?? 0}
              onSwitch={setActiveTab}
              onCreate={
                activeTab === 'labels'
                  ? () => {
                      close();
                      historyUIBus.openCreateLabel();
                    }
                  : null
              }
              sessionDropdown={
                activeTab === 'sessions' ? (
                  <SessionDropdown
                    sessions={sessionsState.sessions ?? []}
                    selectedSessionId={sessionsState.selectedSessionId}
                    onSelect={(id) =>
                      setSessionsState((s) => ({ ...s, selectedSessionId: id }))
                    }
                    t={t}
                  />
                ) : null
              }
              onClose={close}
              t={t}
            />

            {activeTab === 'labels' && labelsState.labels && labelsState.labels.length > 1 && (
              <TimelineStrip
                labels={labelsState.labels}
                selectedId={labelsState.selectedId}
                onSelect={(l) => setLabelsState((s) => ({ ...s, selectedId: l.id }))}
              />
            )}

            <div className="flex min-h-0 flex-1">
              {activeTab === 'labels' ? (
                <LabelsTab
                  state={labelsState}
                  selectedLabel={selectedLabel}
                  onSelect={(id) => setLabelsState((s) => ({ ...s, selectedId: id }))}
                  onRestore={() => void restoreLabel()}
                  onViewDiff={(f) => setDiffViewFile(f)}
                  t={t}
                />
              ) : (
                <SessionsTab
                  state={sessionsState}
                  selectedStep={selectedStep}
                  onSelect={(hashHex) =>
                    setSessionsState((s) => ({ ...s, selectedStepHashHex: hashHex }))
                  }
                  onRestore={() => void restoreStep()}
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

// =============================================================
// Header (tab bar + per-tab actions)
// =============================================================

function TabHeader({
  activeTab,
  labelsCount,
  sessionsCount,
  onSwitch,
  onCreate,
  sessionDropdown,
  onClose,
  t,
}: {
  activeTab: HistoryBrowserTab;
  labelsCount: number;
  sessionsCount: number;
  onSwitch: (tab: HistoryBrowserTab) => void;
  onCreate: (() => void) | null;
  sessionDropdown: ReactElement | null;
  onClose: () => void;
  t: T;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <div className="flex items-center gap-0.5">
        <TabButton
          active={activeTab === 'labels'}
          icon={<FolderOpen size={12} />}
          label={t('history.browseLabels')}
          count={labelsCount}
          onClick={() => onSwitch('labels')}
        />
        <TabButton
          active={activeTab === 'sessions'}
          icon={<MessagesSquare size={12} />}
          label={t('history.browseSessions')}
          count={sessionsCount}
          onClick={() => onSwitch('sessions')}
        />
      </div>
      {sessionDropdown && <div className="min-w-0 flex-1">{sessionDropdown}</div>}
      <div className="ml-auto flex items-center gap-1.5">
        {onCreate && (
          <button
            type="button"
            onClick={onCreate}
            title={t('history.createLabel')}
            aria-label={t('history.createLabel')}
            className="flex cursor-pointer items-center gap-1 rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2 py-1 text-[10px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:bg-[var(--color-accent)]/30"
          >
            <Plus size={11} />
            {t('history.submit')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('history.close')}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: ReactElement;
  label: string;
  count: number;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={
        'flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ' +
        (active
          ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]')
      }
    >
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1 text-[9px] tabular-nums text-[var(--color-text-muted)]">
          {count}
        </span>
      )}
    </button>
  );
}

function SessionDropdown({
  sessions,
  selectedSessionId,
  onSelect,
  t,
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  t: T;
}): ReactElement {
  if (sessions.length === 0) {
    return (
      <span className="text-[11px] text-[var(--color-text-muted)]">
        {t('history.sessionsEmpty')}
      </span>
    );
  }
  return (
    <select
      aria-label={t('history.browseSessions')}
      value={selectedSessionId ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      className="w-full min-w-0 cursor-pointer truncate rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
    >
      {sessions.map((s) => (
        <option key={s.sessionId} value={s.sessionId}>
          {sessionLabel(s, t)} ·{' '}
          {t('history.sessionsStepCount', { count: s.stepCount })} ·{' '}
          {new Date(s.lastTs).toLocaleString()}
        </option>
      ))}
    </select>
  );
}

// =============================================================
// Labels tab
// =============================================================

function LabelsTab({
  state,
  selectedLabel,
  onSelect,
  onRestore,
  onViewDiff,
  t,
}: {
  state: LabelsState;
  selectedLabel: HistoryLabelDTO | null;
  onSelect: (id: string) => void;
  onRestore: () => void;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  return (
    <>
      <LabelListPane
        labels={state.labels ?? []}
        listError={state.listError}
        listLoading={state.listLoading}
        selectedId={state.selectedId}
        onSelect={(l) => onSelect(l.id)}
        t={t}
      />
      <div className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--color-border-subtle)]">
        {!selectedLabel ? (
          <EmptyState promptKey="history.labelSelectPrompt" t={t} />
        ) : (
          <LabelDetailPane
            label={selectedLabel}
            detail={state.detail}
            detailLoading={state.detailLoading}
            restore={state.restore}
            onRestore={onRestore}
            onViewDiff={onViewDiff}
            t={t}
          />
        )}
      </div>
    </>
  );
}

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
      {listLoading && <ListLoading t={t} />}
      {listError === 'labelNoProject' && (
        <ListMessage tone="muted">{t('history.labelNoProject')}</ListMessage>
      )}
      {listError && listError !== 'labelNoProject' && (
        <ListMessage tone="error">{listError}</ListMessage>
      )}
      {!listLoading && !listError && labels.length === 0 && (
        <ListMessage tone="muted">{t('history.labelEmpty')}</ListMessage>
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
                className={listItemClass(isSelected)}
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
  detail: { files: HistoryFileSnapshot[]; error: string | null } | null;
  detailLoading: boolean;
  restore: RestoreState;
  onRestore: () => void;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  const files = detail?.files ?? [];
  const totals = sumTotals(files);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
            {label.name}
          </span>
          <KindChip kind={label.kind} t={t} />
        </div>
        <DetailMetaLine
          time={label.createdAt}
          fileCount={files.length}
          totals={totals}
          t={t}
        />
        {label.description && (
          <div className="mt-1.5 rounded bg-[var(--color-bg-primary)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
            {label.description}
          </div>
        )}
      </div>
      <DetailFileList
        files={files}
        loading={detailLoading}
        error={detail?.error ?? null}
        onViewDiff={onViewDiff}
        t={t}
      />
      <DetailFooter
        restore={restore}
        restoring={restoring}
        onRestore={onRestore}
        restoreLabel={t('history.restore')}
        t={t}
      />
    </div>
  );
}

// =============================================================
// Sessions tab
// =============================================================

function SessionsTab({
  state,
  selectedStep,
  onSelect,
  onRestore,
  onViewDiff,
  t,
}: {
  state: SessionsState;
  selectedStep: HistoryStepDTO | null;
  onSelect: (hashHex: string) => void;
  onRestore: () => void;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  return (
    <>
      <StepListPane
        steps={state.steps ?? []}
        stepsLoading={state.stepsLoading}
        sessionError={state.sessionError}
        selectedHashHex={state.selectedStepHashHex}
        onSelect={(s) => onSelect(bytesToHex(s.hash))}
        t={t}
      />
      <div className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--color-border-subtle)]">
        {!selectedStep ? (
          <EmptyState promptKey="history.stepSelectPrompt" t={t} />
        ) : (
          <StepDetailPane
            step={selectedStep}
            detail={state.stepDetail}
            loading={state.stepDetailLoading}
            restore={state.restore}
            onRestore={onRestore}
            onViewDiff={onViewDiff}
            t={t}
          />
        )}
      </div>
    </>
  );
}

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
      {stepsLoading && <ListLoading t={t} />}
      {sessionError === 'labelNoProject' && (
        <ListMessage tone="muted">{t('history.labelNoProject')}</ListMessage>
      )}
      {!stepsLoading && !sessionError && steps.length === 0 && (
        <ListMessage tone="muted">{t('history.stepsEmpty')}</ListMessage>
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
                className={listItemClass(isSelected)}
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
  detail: { files: HistoryFileSnapshot[]; causes: StepCause[]; error: string | null } | null;
  loading: boolean;
  restore: RestoreState;
  onRestore: () => void;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  const restoring = restore.kind === 'restoring';
  const files = detail?.files ?? [];
  const causes = detail?.causes ?? [];
  const totals = sumTotals(files);
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
        <DetailMetaLine
          time={step.ts}
          fileCount={files.length}
          totals={totals}
          extra={step.sizeDelta > 0 ? `Δ ${step.sizeDelta}B` : undefined}
          t={t}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px]">
        {loading && <InlineLoading t={t} />}
        {!loading && detail?.error && (
          <div className="text-[11px] text-[var(--color-error)]" role="alert">
            {detail.error}
          </div>
        )}
        {!loading && causes.length > 0 && <CausesList causes={causes} />}
        {!loading && (
          <ul className="space-y-0.5 font-mono text-[10px]">
            {files.map((f) => (
              <HistoryFileRow key={f.fileId} file={f} onViewDiff={onViewDiff} t={t} />
            ))}
          </ul>
        )}
      </div>
      <DetailFooter
        restore={restore}
        restoring={restoring}
        onRestore={onRestore}
        restoreLabel={t('history.restore')}
        t={t}
      />
    </div>
  );
}

function CausesList({ causes }: { causes: StepCause[] }): ReactElement {
  return (
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
  );
}

// =============================================================
// Timeline scrubber (labels only)
// =============================================================

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

// =============================================================
// Shared bits
// =============================================================

function EmptyState({ promptKey, t }: { promptKey: TranslationKey; t: T }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Inbox size={32} className="text-[var(--color-text-muted)] opacity-40" />
      <p className="text-[11px] text-[var(--color-text-muted)]">{t(promptKey)}</p>
      <p className="text-[10px] text-[var(--color-text-muted)] opacity-60">
        {t('history.labelKeyboardHint')}
      </p>
    </div>
  );
}

function ListLoading({ t }: { t: T }): ReactElement {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
      <Loader2 size={12} className="motion-safe:animate-spin" />
      {t('history.labelCreating')}
    </div>
  );
}

function InlineLoading({ t }: { t: T }): ReactElement {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
      <Loader2 size={12} className="motion-safe:animate-spin" />
      {t('history.labelCreating')}
    </div>
  );
}

function ListMessage({
  tone,
  children,
}: {
  tone: 'muted' | 'error';
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={
        'px-3 py-4 text-center text-[11px] ' +
        (tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]')
      }
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}

function DetailMetaLine({
  time,
  fileCount,
  totals,
  extra,
  t,
}: {
  time: number;
  fileCount: number;
  totals: { added: number; removed: number };
  extra?: string;
  t: T;
}): ReactElement {
  const hasChanges = totals.added > 0 || totals.removed > 0;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
      <span>{new Date(time).toLocaleString()}</span>
      <span>·</span>
      <span>{t('history.labelFilesCount', { count: fileCount })}</span>
      {hasChanges && (
        <>
          <span>·</span>
          <span className="text-[var(--color-success)]">+{totals.removed}</span>
          <span>/</span>
          <span className="text-[var(--color-error)]">-{totals.added}</span>
        </>
      )}
      {extra && (
        <>
          <span>·</span>
          <span>{extra}</span>
        </>
      )}
    </div>
  );
}

function DetailFileList({
  files,
  loading,
  error,
  onViewDiff,
  t,
}: {
  files: HistoryFileSnapshot[];
  loading: boolean;
  error: string | null;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {loading && <InlineLoading t={t} />}
      {!loading && error && (
        <div className="text-[11px] text-[var(--color-error)]" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && (
        <ul className="space-y-0.5 font-mono text-[10px]">
          {files.map((f) => (
            <HistoryFileRow key={f.fileId} file={f} onViewDiff={onViewDiff} t={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailFooter({
  restore,
  restoring,
  onRestore,
  restoreLabel,
  t,
}: {
  restore: RestoreState;
  restoring: boolean;
  onRestore: () => void;
  restoreLabel: string;
  t: T;
}): ReactElement {
  return (
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
        {restoring ? t('history.restoring') : restoreLabel}
      </button>
    </div>
  );
}

// =============================================================
// Helpers
// =============================================================

function listItemClass(isSelected: boolean): string {
  return (
    'flex w-full cursor-pointer items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors focus:outline-none ' +
    (isSelected
      ? 'border-l-[var(--color-accent)] bg-[var(--color-accent-muted)]/40 '
      : 'border-l-transparent hover:bg-[var(--color-bg-hover)] focus-visible:bg-[var(--color-bg-hover)]')
  );
}

function snapshotToFiles(map: Record<string, Uint8Array>): HistoryFileSnapshot[] {
  const tabs = getEditorService().tabs;
  const decoder = new TextDecoder();
  return Object.keys(map)
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
}

function sumTotals(files: HistoryFileSnapshot[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.stats?.added ?? 0;
    removed += f.stats?.removed ?? 0;
  }
  return { added, removed };
}

function moveLabelSelection(
  state: LabelsState,
  set: (updater: (s: LabelsState) => LabelsState) => void,
  delta: 1 | -1
): void {
  const labels = state.labels;
  if (!labels || labels.length === 0) return;
  const idx = state.selectedId ? labels.findIndex((l) => l.id === state.selectedId) : -1;
  const nextIdx = Math.min(Math.max(idx + delta, 0), labels.length - 1);
  const next = labels[nextIdx];
  if (next) set((s) => ({ ...s, selectedId: next.id }));
}

function moveStepSelection(
  state: SessionsState,
  set: (updater: (s: SessionsState) => SessionsState) => void,
  delta: 1 | -1
): void {
  const steps = state.steps;
  if (!steps || steps.length === 0) return;
  const current = state.selectedStepHashHex;
  const idx = current ? steps.findIndex((s) => bytesToHex(s.hash) === current) : -1;
  const nextIdx = Math.min(Math.max(idx + delta, 0), steps.length - 1);
  const next = steps[nextIdx];
  if (next) set((s) => ({ ...s, selectedStepHashHex: bytesToHex(next.hash) }));
}

// ----- Chips / icons -----

function KindChip({ kind, t }: { kind: HistoryLabelDTO['kind']; t: T }): ReactElement {
  const color = kindColor(kind);
  const key: TranslationKey =
    kind === 'manual'
      ? 'history.labelKindManual'
      : kind === 'milestone'
        ? 'history.labelKindMilestone'
        : 'history.labelKindAuto';
  return <Chip color={color} text={t(key)} />;
}

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
  return <Chip color={entry.color} text={t(entry.key)} />;
}

function Chip({ color, text }: { color: string; text: string }): ReactElement {
  return (
    <span
      className="rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider"
      style={{
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
        color,
      }}
    >
      {text}
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
