/**
 * @file AITab.tsx - AI Agent Settings Tab
 * @description 两节:基础连接 + 模型路由。The user picks a protocol family (OpenAI-
 *   compatible or Anthropic-compatible) and points it at whichever base
 *   URL their provider exposes — SNACA and Ctrl+K both use the same
 *   credentials. Brand-level provider names (DeepSeek, SiliconFlow, …)
 *   are intentionally not enumerated here: every modern gateway speaks
 *   one of these two protocols.
 */

import { Loader2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { AIProviderDTO, SelectedModels } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import type { ProviderId } from '../../types/provider';
import {
  FormField,
  FormSection,
  inputMonoClassName,
  secondaryButtonClass,
  selectClassName,
} from './SettingsUI';

type ModelSelection = NonNullable<SelectedModels['chat']>;

interface ProviderOption {
  /** ProviderId stored in settings. */
  id: ProviderId;
  /** Label shown in the dropdown. */
  label: string;
  /** Placeholder used as a UX hint when the host field is empty. */
  defaultHost: string;
  /** Two short examples of common upstream endpoints under this protocol. */
  hostExamples: string[];
}

// Only two entries — the protocol family is what matters; the base URL
// is where the user encodes which actual vendor they're hitting.
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    defaultHost: 'https://api.openai.com/v1',
    // Studio AIService auto-appends `/v1` if missing, so both bare host and
    // `/v1` form work — show both to make the convention obvious.
    hostExamples: ['https://api.openai.com/v1', 'https://api.deepseek.com'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic 兼容',
    defaultHost: 'https://api.anthropic.com',
    hostExamples: ['https://api.anthropic.com', 'https://api.deepseek.com/anthropic'],
  },
];

function makeProvider(id: ProviderId): AIProviderDTO {
  const opt = PROVIDER_OPTIONS.find((o) => o.id === id);
  return {
    id,
    name: opt?.label ?? id,
    apiKey: '',
    apiHost: opt?.defaultHost ?? '',
    defaultApiHost: opt?.defaultHost ?? '',
    enabled: true,
    models: [],
  };
}

/**
 * Map any historical Studio ProviderId (deepseek/dashscope/siliconflow/…)
 * to the new two-protocol scheme. Anthropic stays Anthropic; everything
 * else lands on `openai` (the OpenAI-compatible protocol family). Users
 * disambiguate by editing the base URL.
 */
function normalizeProviderId(id: ProviderId): ProviderId {
  return id === 'anthropic' ? 'anthropic' : 'openai';
}

export const AITab: React.FC = () => {
  const { t } = useTranslation();
  const settingsService = getSettingsService();

  const [provider, setProvider] = useState<AIProviderDTO | null>(null);
  const [chatModel, setChatModel] = useState('');
  const [completionModel, setCompletionModel] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Initial load. Picks a provider in this order: chat selection → completion
  // selection → first existing → openai default. Models inputs default to
  // whatever the user already selected; completion left blank means "same as
  // chat" downstream.
  useEffect(() => {
    (async () => {
      const config = await settingsService.getAIConfig();

      const chatSel = config.selectedModels.chat;
      const complSel = config.selectedModels.completion;
      const activeId: ProviderId = normalizeProviderId(
        (chatSel?.providerId ??
          complSel?.providerId ??
          config.providers[0]?.id ??
          'openai') as ProviderId
      );

      const existing = config.providers.find((p) => p.id === activeId);
      setProvider(existing ?? makeProvider(activeId));
      setChatModel(chatSel?.modelId ?? '');
      setCompletionModel(complSel?.modelId ?? '');
    })();
  }, [settingsService]);

  // Persist whenever any field updates. Writes a single provider entry plus
  // chat/completion selections that share the providerId.
  const persist = useCallback(
    async (next: {
      provider?: AIProviderDTO;
      chatModel?: string;
      completionModel?: string;
    }) => {
      const p = next.provider ?? provider;
      if (!p) return;
      const chat = next.chatModel ?? chatModel;
      const compl = next.completionModel ?? completionModel;

      // Completion model is optional. When blank, fall back to the chat
      // model so AIService.createCompletionModel() still has something to
      // hit.
      const effectiveCompletion = compl || chat;

      const chatSelection: ModelSelection | null = chat
        ? { providerId: p.id, modelId: chat }
        : null;
      const completionSelection: ModelSelection | null = effectiveCompletion
        ? { providerId: p.id, modelId: effectiveCompletion }
        : null;

      const dto: { providers: AIProviderDTO[]; selectedModels: SelectedModels } = {
        providers: [p],
        selectedModels: {
          chat: chatSelection,
          completion: completionSelection,
          vision: null,
          tts: null,
          stt: null,
        },
      };
      await settingsService.setAIConfig(dto);
    },
    [provider, chatModel, completionModel, settingsService]
  );

  // ----- per-input handlers -----

  const updateProvider = useCallback(
    (patch: Partial<AIProviderDTO>) => {
      if (!provider) return;
      const merged: AIProviderDTO = { ...provider, ...patch };
      setProvider(merged);
      void persist({ provider: merged });
    },
    [provider, persist]
  );

  const changeProvider = useCallback(
    (id: ProviderId) => {
      setTestResult(null);
      const next = makeProvider(id);
      // Preserve the prior key when it makes sense — users often paste the
      // same key for `custom` providers regardless of the dropdown choice.
      if (provider?.apiKey) next.apiKey = provider.apiKey;
      setProvider(next);
      void persist({ provider: next });
    },
    [provider, persist]
  );

  const commitChatModel = useCallback(
    (value: string) => {
      setChatModel(value);
      void persist({ chatModel: value });
    },
    [persist]
  );

  const commitCompletionModel = useCallback(
    (value: string) => {
      setCompletionModel(value);
      void persist({ completionModel: value });
    },
    [persist]
  );

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.ai.testConnection();
      setTestResult(
        result.success
          ? { ok: true, msg: t('aiSettings.testSuccess') }
          : { ok: false, msg: result.message || t('aiSettings.testFailed') }
      );
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }, [t]);

  // Placeholder host shown in the input — surface the protocol's two
  // canonical examples (e.g. OpenAI's own host vs DeepSeek's OpenAI gateway)
  // so the user knows what kind of URL is expected.
  const hostPlaceholder = useMemo(() => {
    if (!provider) return 'https://...';
    const opt = PROVIDER_OPTIONS.find((o) => o.id === provider.id);
    return opt ? `e.g. ${opt.hostExamples.join('  /  ')}` : 'https://...';
  }, [provider]);

  if (!provider) {
    return (
      <div className="text-sm text-[var(--color-text-muted)] py-4">
        {t('aiSettings.provider')}…
      </div>
    );
  }

  return (
    <div>
      <FormSection title={t('aiSettings.sectionConnection')} first>
        <FormField title={t('aiSettings.provider')} description={t('aiSettings.providerDesc')}>
          <select
            value={provider.id}
            onChange={(e) => changeProvider(e.target.value as ProviderId)}
            className={selectClassName}
          >
            {PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField title={t('aiSettings.apiKey')} description={t('aiSettings.apiKeyDesc')}>
          <input
            type="password"
            value={provider.apiKey}
            onChange={(e) => updateProvider({ apiKey: e.target.value })}
            placeholder="sk-..."
            className={inputMonoClassName}
          />
        </FormField>

        <FormField title={t('aiSettings.baseUrl')} description={t('aiSettings.baseUrlDesc')}>
          <input
            type="text"
            value={provider.apiHost}
            onChange={(e) => updateProvider({ apiHost: e.target.value })}
            placeholder={hostPlaceholder}
            className={inputMonoClassName}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing || !provider.apiKey}
              className={secondaryButtonClass}
            >
              {testing && <Loader2 size={14} className="animate-spin" />}
              {t('aiSettings.testConnection')}
            </button>
            {testResult && (
              <span
                className={`text-xs ${testResult.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}
              >
                {testResult.msg}
              </span>
            )}
          </div>
        </FormField>
      </FormSection>

      <FormSection title={t('aiSettings.sectionModelRouting')}>
        <FormField title={t('aiSettings.chatModel')} description={t('aiSettings.chatModelDesc')}>
          <input
            type="text"
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            onBlur={() => commitChatModel(chatModel)}
            placeholder="deepseek-chat"
            className={inputMonoClassName}
          />
        </FormField>

        <FormField title={t('aiSettings.model')} description={t('aiSettings.modelDesc')}>
          <input
            type="text"
            value={completionModel}
            onChange={(e) => setCompletionModel(e.target.value)}
            onBlur={() => commitCompletionModel(completionModel)}
            placeholder={chatModel || 'gpt-4o-mini'}
            className={inputMonoClassName}
          />
        </FormField>
      </FormSection>
    </div>
  );
};
