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
  mcp_idle_ttl_secs?: number;
  mcp_reaper_period_secs?: number;
  stream_tool_execution?: boolean;
  memory_extractor?: boolean;
  memory_extractor_model?: string;
}

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
  | 'max_output_token_ceiling'
  | 'mcp_idle_ttl_secs'
  | 'mcp_reaper_period_secs';

type BoolKey = 'stream_tool_execution' | 'memory_extractor';

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
  {
    key: 'mcp_idle_ttl_secs',
    labelKey: 'settingsAgent.engine.mcpIdleTtlSecs',
    descKey: 'settingsAgent.engine.mcpIdleTtlSecsDesc',
    placeholder: '600',
    allowZero: true,
  },
  {
    key: 'mcp_reaper_period_secs',
    labelKey: 'settingsAgent.engine.mcpReaperPeriodSecs',
    descKey: 'settingsAgent.engine.mcpReaperPeriodSecsDesc',
    placeholder: '60',
    allowZero: true,
  },
];

/** Boolean knobs. `engineDefault` is what SNACA uses when the field is
 *  unset — the UI displays that value so users see actual behaviour
 *  rather than an ambiguous "default" option. Any interaction always
 *  persists an explicit `true` or `false`. */
const BOOL_FIELDS: Array<{
  key: BoolKey;
  labelKey: string;
  descKey: string;
  engineDefault: boolean;
}> = [
  {
    key: 'stream_tool_execution',
    labelKey: 'settingsAgent.engine.streamToolExecution',
    descKey: 'settingsAgent.engine.streamToolExecutionDesc',
    engineDefault: true,
  },
  {
    key: 'memory_extractor',
    labelKey: 'settingsAgent.engine.memoryExtractor',
    descKey: 'settingsAgent.engine.memoryExtractorDesc',
    engineDefault: false,
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
    (key: BoolKey, value: boolean) => {
      const next = { ...engine };
      next[key] = value;
      persistEngine(next);
    },
    [engine, persistEngine]
  );
  const updateString = useCallback(
    (key: 'memory_extractor_model', raw: string) => {
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
            // Unset persisted value → show the engine default so the UI
            // reflects what's actually happening. Any user interaction
            // then writes an explicit boolean.
            const effective = engine[field.key] ?? field.engineDefault;
            return (
              <SettingItem
                key={field.key}
                label={t(field.labelKey as never)}
                description={t(field.descKey as never)}
              >
                <select
                  value={effective ? 'true' : 'false'}
                  onChange={(e) => updateBool(field.key, e.target.value === 'true')}
                  className={selectClassName}
                >
                  <option value="true">{t('settingsAgent.engine.boolOn' as never)}</option>
                  <option value="false">{t('settingsAgent.engine.boolOff' as never)}</option>
                </select>
              </SettingItem>
            );
          })}

          <SettingItem
            label={t('settingsAgent.engine.memoryExtractorModel' as never)}
            description={t('settingsAgent.engine.memoryExtractorModelDesc' as never)}
          >
            <input
              type="text"
              value={engine.memory_extractor_model ?? ''}
              placeholder="deepseek-chat"
              onChange={(e) => updateString('memory_extractor_model', e.target.value)}
              className={inputClassName}
            />
          </SettingItem>

          <p className="text-[11px] text-amber-400/80 mt-2">
            {t('settingsAgent.engine.restartHint')}
          </p>
        </>
      )}

    </>
  );
};
