/**
 * @file AgentTab.tsx — AI agent runtime settings + memory/skills launcher.
 *
 * Three sections:
 *  - Memory / Skills viewer launchers (secondary window)
 *  - Approval mode — controls SNACA's per-turn approval gate
 *  - Advanced engine knobs — folded by default; mirrors a subset of
 *    `SnacaConfig.engine`.
 *
 * Approval mode + engine overrides are read by SNACA at `init` time, so
 * persisting them triggers a debounced sidecar restart via the
 * subscribers in agentHandlers. Settings is the right home for these
 * (they are configuration, unlike Memory which is runtime data).
 */

import { BookOpen, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ConfigKeys } from '../../../../../shared/types/config-keys';
import { useTranslation } from '../../locales';
import { agentClient } from '../../services/agent/AgentClientService';
import { McpServersSection } from './McpServersSection';
import { SectionTitle, SettingItem, inputClassName } from './SettingsUI';

type ApprovalMode = 'interactive' | 'auto_allow' | 'auto_deny';

/** Subset of `SnacaConfig.engine` we surface in the UI. Keys mirror the
 *  wire shape (snake_case) so persisted values pass straight through to
 *  `buildSnacaConfigFromSettings`. */
interface EngineOverrides {
  max_iterations?: number;
  loop_guard_max_repeats?: number;
  concurrent_tool_limit?: number;
  max_tokens?: number;
  history_limit?: number;
  compact_after_input_tokens?: number;
  compact_summary_max_tokens?: number;
  history_max_bytes?: number;
  // 0 = disabled per protocol convention; we allow 0 here so the user
  // can explicitly turn the timeout off via the input.
  turn_timeout_secs?: number;
  collapse_tool_results_threshold?: number;
  max_output_token_escalation_attempts?: number;
  max_output_token_ceiling?: number;
  stream_tool_execution?: boolean;
  memory_reranker?: boolean;
  memory_reranker_model?: string;
  memory_embedder?: MemoryEmbedderKind;
}

type MemoryEmbedderKind = 'none' | 'hash' | 'fastembed';

type NumberKey =
  | 'max_iterations'
  | 'loop_guard_max_repeats'
  | 'concurrent_tool_limit'
  | 'max_tokens'
  | 'history_limit'
  | 'compact_after_input_tokens'
  | 'compact_summary_max_tokens'
  | 'history_max_bytes'
  | 'turn_timeout_secs'
  | 'collapse_tool_results_threshold'
  | 'max_output_token_escalation_attempts'
  | 'max_output_token_ceiling';

type BoolKey = 'stream_tool_execution' | 'memory_reranker';

const NUMBER_FIELDS: Array<{
  key: NumberKey;
  labelKey: string;
  descKey: string;
  placeholder: string;
  /** Some fields accept 0 (means "disabled"); most reject 0 as
   *  meaningless. Default behaviour is "positive only". */
  allowZero?: boolean;
}> = [
  {
    key: 'max_iterations',
    labelKey: 'settingsAgent.engine.maxIterations',
    descKey: 'settingsAgent.engine.maxIterationsDesc',
    placeholder: '30',
  },
  {
    key: 'loop_guard_max_repeats',
    labelKey: 'settingsAgent.engine.loopGuard',
    descKey: 'settingsAgent.engine.loopGuardDesc',
    placeholder: '3',
  },
  {
    key: 'history_limit',
    labelKey: 'settingsAgent.engine.historyLimit',
    descKey: 'settingsAgent.engine.historyLimitDesc',
    placeholder: '40',
  },
  {
    key: 'max_tokens',
    labelKey: 'settingsAgent.engine.maxTokens',
    descKey: 'settingsAgent.engine.maxTokensDesc',
    placeholder: '8192',
  },
  {
    key: 'concurrent_tool_limit',
    labelKey: 'settingsAgent.engine.concurrentTools',
    descKey: 'settingsAgent.engine.concurrentToolsDesc',
    placeholder: '4',
  },
  {
    key: 'compact_after_input_tokens',
    labelKey: 'settingsAgent.engine.compactAfter',
    descKey: 'settingsAgent.engine.compactAfterDesc',
    placeholder: '160000',
  },
  {
    key: 'compact_summary_max_tokens',
    labelKey: 'settingsAgent.engine.compactSummaryMaxTokens',
    descKey: 'settingsAgent.engine.compactSummaryMaxTokensDesc',
    placeholder: '2048',
  },
  {
    key: 'history_max_bytes',
    labelKey: 'settingsAgent.engine.historyMaxBytes',
    descKey: 'settingsAgent.engine.historyMaxBytesDesc',
    placeholder: '1500000',
  },
  {
    key: 'turn_timeout_secs',
    labelKey: 'settingsAgent.engine.turnTimeoutSecs',
    descKey: 'settingsAgent.engine.turnTimeoutSecsDesc',
    placeholder: '0',
    allowZero: true,
  },
  {
    key: 'collapse_tool_results_threshold',
    labelKey: 'settingsAgent.engine.collapseToolResultsThreshold',
    descKey: 'settingsAgent.engine.collapseToolResultsThresholdDesc',
    placeholder: '1024',
    allowZero: true,
  },
  {
    key: 'max_output_token_escalation_attempts',
    labelKey: 'settingsAgent.engine.maxOutputTokenEscalationAttempts',
    descKey: 'settingsAgent.engine.maxOutputTokenEscalationAttemptsDesc',
    placeholder: '2',
    allowZero: true,
  },
  {
    key: 'max_output_token_ceiling',
    labelKey: 'settingsAgent.engine.maxOutputTokenCeiling',
    descKey: 'settingsAgent.engine.maxOutputTokenCeilingDesc',
    placeholder: '32768',
  },
];

const BOOL_FIELDS: Array<{ key: BoolKey; labelKey: string; descKey: string }> = [
  {
    key: 'stream_tool_execution',
    labelKey: 'settingsAgent.engine.streamToolExecution',
    descKey: 'settingsAgent.engine.streamToolExecutionDesc',
  },
  {
    key: 'memory_reranker',
    labelKey: 'settingsAgent.engine.memoryReranker',
    descKey: 'settingsAgent.engine.memoryRerankerDesc',
  },
];

const selectClassName =
  'h-9 px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] ' +
  'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] ' +
  'focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';

export const AgentTab: React.FC = () => {
  const { t } = useTranslation();

  // --- Memory / Skills launchers --------------------------------------

  const openMemory = useCallback(() => {
    void agentClient.openMemoryViewer('memory');
  }, []);
  const openSkills = useCallback(() => {
    void agentClient.openMemoryViewer('skills');
  }, []);

  // --- Approval mode --------------------------------------------------

  const [approval, setApproval] = useState<ApprovalMode>('interactive');
  useEffect(() => {
    void api.config
      .get<ApprovalMode | undefined>(ConfigKeys.AgentApprovalMode)
      .then((v) => {
        if (v === 'auto_allow' || v === 'auto_deny' || v === 'interactive') {
          setApproval(v);
        }
      });
  }, []);
  const onApprovalChange = useCallback((next: ApprovalMode) => {
    setApproval(next);
    void api.config.set(ConfigKeys.AgentApprovalMode, next, true);
  }, []);

  // --- Engine overrides ----------------------------------------------

  const [engine, setEngine] = useState<EngineOverrides>({});
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    void api.config.get<EngineOverrides | undefined>(ConfigKeys.AgentEngineConfig).then((v) => {
      if (v && typeof v === 'object') setEngine(v);
    });
  }, []);
  const persistEngine = useCallback((next: EngineOverrides) => {
    setEngine(next);
    void api.config.set(ConfigKeys.AgentEngineConfig, next, true);
  }, []);
  const updateNumber = useCallback(
    (key: NumberKey, raw: string, allowZero: boolean) => {
      const trimmed = raw.trim();
      const next = { ...engine };
      if (!trimmed) {
        delete next[key];
      } else {
        const n = Number(trimmed);
        if (!Number.isFinite(n)) return;
        if (n < 0) return;
        if (n === 0 && !allowZero) return;
        next[key] = Math.floor(n);
      }
      persistEngine(next);
    },
    [engine, persistEngine]
  );
  const updateBool = useCallback(
    (key: BoolKey, value: boolean | undefined) => {
      const next = { ...engine };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      persistEngine(next);
    },
    [engine, persistEngine]
  );
  const updateString = useCallback(
    (key: 'memory_reranker_model', raw: string) => {
      const trimmed = raw.trim();
      const next = { ...engine };
      if (!trimmed) {
        delete next[key];
      } else {
        next[key] = trimmed;
      }
      persistEngine(next);
    },
    [engine, persistEngine]
  );

  // --- FastEmbed pre-download state ---
  //
  // The dropdown is bound to the persisted `engine.memory_embedder`.
  // Selecting "fastembed" opens this modal instead of writing through;
  // only on a successful `downloadFastEmbed` do we persist. The dropdown
  // therefore reflects "what's actually in use", not "what the user
  // clicked".
  type DownloadPhase = 'idle' | 'downloading' | 'success' | 'failed';
  const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>('idle');
  const [downloadProgress, setDownloadProgress] = useState<string>('');
  const [downloadError, setDownloadError] = useState<string>('');
  const [modalOpen, setModalOpen] = useState(false);

  // Subscribe to stderr-derived progress while the modal is showing.
  // Each line replaces the previous one — we don't accumulate a log,
  // just give the user a live "still working" signal.
  useEffect(() => {
    if (!modalOpen) return undefined;
    return agentClient.onFastEmbedDownloadProgress((line) => {
      setDownloadProgress(line);
    });
  }, [modalOpen]);

  const persistEmbedder = useCallback(
    (kind: MemoryEmbedderKind) => {
      const next = { ...engine };
      if (kind === 'hash') {
        // Hash is the engine default; storing it is redundant noise and
        // makes the wire payload bigger. Drop it instead.
        delete next.memory_embedder;
      } else {
        next.memory_embedder = kind;
      }
      persistEngine(next);
    },
    [engine, persistEngine]
  );

  const startFastEmbedDownload = useCallback(async () => {
    setDownloadPhase('downloading');
    setDownloadProgress('');
    setDownloadError('');
    const result = await agentClient.downloadFastEmbed();
    if (result.ok) {
      persistEmbedder('fastembed');
      setDownloadPhase('success');
    } else {
      setDownloadPhase('failed');
      setDownloadError(result.error);
    }
  }, [persistEmbedder]);

  const onEmbedderChange = useCallback(
    (kind: MemoryEmbedderKind) => {
      // The current persisted choice. Hash defaults to "no override" so
      // an absent field reads as 'hash' for UI purposes.
      const current: MemoryEmbedderKind = engine.memory_embedder ?? 'hash';
      if (kind === current) return;
      if (kind === 'fastembed') {
        // Defer the persist until after the download flow succeeds.
        setDownloadPhase('idle');
        setDownloadProgress('');
        setDownloadError('');
        setModalOpen(true);
      } else {
        persistEmbedder(kind);
      }
    },
    [engine.memory_embedder, persistEmbedder]
  );

  const closeModal = useCallback(() => {
    // Closing mid-download abandons UI tracking — the child process
    // keeps running. Subsequent sidecar inits will pick up the cached
    // model if/when it finishes. We only persist on explicit success
    // so a partial download won't break the next session.
    setModalOpen(false);
    setDownloadPhase('idle');
    setDownloadProgress('');
    setDownloadError('');
  }, []);

  const buttonClass =
    'inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border ' +
    'border-[var(--color-border)] bg-[var(--color-bg-secondary)] ' +
    'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]';

  return (
    <>
      {/* ---------- Memory / Skills viewer launchers ---------- */}
      <SectionTitle>{t('settingsAgent.viewer')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('settingsAgent.viewerDesc')}
      </p>

      <SettingItem
        label={t('settingsAgent.memoryLabel')}
        description={t('settingsAgent.memoryDesc')}
      >
        <button type="button" onClick={openMemory} className={buttonClass}>
          <Brain size={14} />
          {t('settingsAgent.openMemory')}
        </button>
      </SettingItem>

      <SettingItem
        label={t('settingsAgent.skillsLabel')}
        description={t('settingsAgent.skillsDesc')}
      >
        <button type="button" onClick={openSkills} className={buttonClass}>
          <BookOpen size={14} />
          {t('settingsAgent.openSkills')}
        </button>
      </SettingItem>

      {/* ---------- Approval mode ---------- */}
      <SectionTitle>{t('settingsAgent.approval.title')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('settingsAgent.approval.desc')}
      </p>
      <SettingItem
        label={t('settingsAgent.approval.mode')}
        description={t('settingsAgent.approval.modeDesc')}
      >
        <select
          value={approval}
          onChange={(e) => onApprovalChange(e.target.value as ApprovalMode)}
          className={selectClassName}
        >
          <option value="interactive">{t('settingsAgent.approval.interactive')}</option>
          <option value="auto_allow">{t('settingsAgent.approval.autoAllow')}</option>
          <option value="auto_deny">{t('settingsAgent.approval.autoDeny')}</option>
        </select>
      </SettingItem>

      {/* ---------- MCP Servers ---------- */}
      <McpServersSection />

      {/* ---------- Engine advanced ---------- */}
      <SectionTitle>{t('settingsAgent.engine.title')}</SectionTitle>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="-mt-1 mb-2 inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t(expanded ? 'settingsAgent.engine.collapse' : 'settingsAgent.engine.expand')}
      </button>

      {expanded && (
        <>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">
            {t('settingsAgent.engine.desc')}
          </p>

          {NUMBER_FIELDS.map((field) => {
            const value = engine[field.key];
            const allowZero = field.allowZero ?? false;
            return (
              <SettingItem
                key={field.key}
                label={t(field.labelKey as never)}
                description={t(field.descKey as never)}
              >
                <input
                  type="number"
                  min={allowZero ? 0 : 1}
                  value={typeof value === 'number' ? value : ''}
                  placeholder={field.placeholder}
                  onChange={(e) => updateNumber(field.key, e.target.value, allowZero)}
                  className={inputClassName}
                />
              </SettingItem>
            );
          })}

          {BOOL_FIELDS.map((field) => {
            const value = engine[field.key];
            return (
              <SettingItem
                key={field.key}
                label={t(field.labelKey as never)}
                description={t(field.descKey as never)}
              >
                {/* tri-state: undefined (engine default) / true / false. Mapped
                    through a select rather than a checkbox so "leave as default"
                    is a distinct choice from "explicitly off". */}
                <select
                  value={value === undefined ? '' : value ? 'true' : 'false'}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateBool(field.key, v === '' ? undefined : v === 'true');
                  }}
                  className={selectClassName}
                >
                  <option value="">{t('settingsAgent.engine.boolDefault' as never)}</option>
                  <option value="true">{t('settingsAgent.engine.boolOn' as never)}</option>
                  <option value="false">{t('settingsAgent.engine.boolOff' as never)}</option>
                </select>
              </SettingItem>
            );
          })}

          <SettingItem
            label={t('settingsAgent.engine.memoryEmbedder' as never)}
            description={t('settingsAgent.engine.memoryEmbedderDesc' as never)}
          >
            <select
              value={engine.memory_embedder ?? 'hash'}
              onChange={(e) => onEmbedderChange(e.target.value as MemoryEmbedderKind)}
              className={selectClassName}
            >
              <option value="none">{t('settingsAgent.engine.embedderNone' as never)}</option>
              <option value="hash">{t('settingsAgent.engine.embedderHash' as never)}</option>
              <option value="fastembed">
                {t('settingsAgent.engine.embedderFastembed' as never)}
              </option>
            </select>
          </SettingItem>

          <SettingItem
            label={t('settingsAgent.engine.memoryRerankerModel' as never)}
            description={t('settingsAgent.engine.memoryRerankerModelDesc' as never)}
          >
            <input
              type="text"
              value={engine.memory_reranker_model ?? ''}
              placeholder="deepseek-chat"
              onChange={(e) => updateString('memory_reranker_model', e.target.value)}
              className={inputClassName}
            />
          </SettingItem>

          <p className="text-[11px] text-amber-400/80 mt-2">
            {t('settingsAgent.engine.restartHint')}
          </p>
        </>
      )}

      {/* ---------- FastEmbed download modal ---------- */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          // Click on backdrop closes only when not downloading — we'd
          // rather the user explicitly cancel than rage-quit a flow.
          onClick={() => {
            if (downloadPhase !== 'downloading') closeModal();
          }}
        >
          <div
            className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">
              {t('settingsAgent.engine.fastembedModalTitle' as never)}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              {t('settingsAgent.engine.fastembedModalDesc' as never)}
            </p>

            {downloadPhase === 'downloading' && (
              <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
                <p className="text-xs text-[var(--color-text-primary)] mb-1">
                  {t('settingsAgent.engine.fastembedDownloading' as never)}
                </p>
                <p className="text-[11px] text-[var(--color-text-muted)] font-mono break-all line-clamp-2">
                  {downloadProgress || '…'}
                </p>
              </div>
            )}

            {downloadPhase === 'success' && (
              <p className="mb-3 text-xs text-emerald-400">
                {t('settingsAgent.engine.fastembedSuccess' as never)}
              </p>
            )}

            {downloadPhase === 'failed' && (
              <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-2">
                <p className="text-xs text-red-400 mb-1">
                  {t('settingsAgent.engine.fastembedFailed' as never)}
                </p>
                <p className="text-[11px] text-[var(--color-text-muted)] font-mono break-all">
                  {downloadError}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              {downloadPhase === 'idle' && (
                <>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  >
                    {t('settingsAgent.engine.fastembedCancel' as never)}
                  </button>
                  <button
                    type="button"
                    onClick={startFastEmbedDownload}
                    className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-white hover:opacity-90"
                  >
                    {t('settingsAgent.engine.fastembedStart' as never)}
                  </button>
                </>
              )}
              {downloadPhase === 'downloading' && (
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                >
                  {t('settingsAgent.engine.fastembedCancel' as never)}
                </button>
              )}
              {downloadPhase === 'failed' && (
                <>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  >
                    {t('settingsAgent.engine.fastembedClose' as never)}
                  </button>
                  <button
                    type="button"
                    onClick={startFastEmbedDownload}
                    className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-white hover:opacity-90"
                  >
                    {t('settingsAgent.engine.fastembedRetry' as never)}
                  </button>
                </>
              )}
              {downloadPhase === 'success' && (
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-white hover:opacity-90"
                >
                  {t('settingsAgent.engine.fastembedClose' as never)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
