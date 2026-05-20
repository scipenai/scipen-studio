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
import { SectionTitle, SettingItem, inputClassName } from './SettingsUI';

type ApprovalMode = 'interactive' | 'auto_allow' | 'auto_deny';
type MemoryEmbedder = 'none' | 'hash' | 'fastembed';

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
  memory_extractor?: boolean;
  memory_embedder?: MemoryEmbedder;
}

const NUMBER_FIELDS: Array<{
  key: keyof EngineOverrides;
  labelKey: string;
  descKey: string;
  placeholder: string;
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
    (key: keyof EngineOverrides, raw: string) => {
      const trimmed = raw.trim();
      const next = { ...engine };
      if (!trimmed) {
        delete next[key];
      } else {
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n <= 0) return;
        (next as Record<string, unknown>)[key] = Math.floor(n);
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
      <p className="text-[11px] text-amber-400/80 mb-1">
        {t('settingsAgent.approval.restartHint')}
      </p>

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
            return (
              <SettingItem
                key={field.key}
                label={t(field.labelKey as never)}
                description={t(field.descKey as never)}
              >
                <input
                  type="number"
                  min={1}
                  value={typeof value === 'number' ? value : ''}
                  placeholder={field.placeholder}
                  onChange={(e) => updateNumber(field.key, e.target.value)}
                  className={inputClassName}
                />
              </SettingItem>
            );
          })}

          <SettingItem
            label={t('settingsAgent.engine.memoryExtractor')}
            description={t('settingsAgent.engine.memoryExtractorDesc')}
          >
            <select
              value={engine.memory_extractor === false ? 'off' : 'on'}
              onChange={(e) =>
                persistEngine({ ...engine, memory_extractor: e.target.value === 'on' })
              }
              className={selectClassName}
            >
              <option value="on">{t('settingsAgent.engine.on')}</option>
              <option value="off">{t('settingsAgent.engine.off')}</option>
            </select>
          </SettingItem>

          <SettingItem
            label={t('settingsAgent.engine.memoryEmbedder')}
            description={t('settingsAgent.engine.memoryEmbedderDesc')}
          >
            <select
              value={engine.memory_embedder ?? 'none'}
              onChange={(e) =>
                persistEngine({
                  ...engine,
                  memory_embedder: e.target.value as MemoryEmbedder,
                })
              }
              className={selectClassName}
            >
              <option value="none">none</option>
              <option value="hash">hash</option>
              <option value="fastembed">fastembed</option>
            </select>
          </SettingItem>

          <p className="text-[11px] text-amber-400/80 mt-2">
            {t('settingsAgent.engine.restartHint')}
          </p>
        </>
      )}
    </>
  );
};
