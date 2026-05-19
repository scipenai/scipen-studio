/**
 * @file AITab.tsx - AI Agent Settings Tab
 * @description Single "AI Agent" section: one provider + apiKey + apiHost,
 *   shared by SNACA (chat / tools / Diff review) and Ctrl+K (ghost-text).
 *   Two model inputs sit underneath: Agent Model (selectedModels.chat) and
 *   Completion Model (selectedModels.completion). Completion is optional —
 *   when blank it falls back to the Agent model.
 */

import { Loader2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { AIProviderDTO, SelectedModels } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import type { ProviderId } from '../../types/provider';
import { SectionTitle, SettingItem, inputClassName } from './SettingsUI';

type ModelSelection = NonNullable<SelectedModels['chat']>;

interface ProviderOption {
  id: ProviderId;
  label: string;
  defaultHost: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'openai', label: 'OpenAI', defaultHost: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', defaultHost: 'https://api.anthropic.com' },
  { id: 'deepseek', label: 'DeepSeek', defaultHost: 'https://api.deepseek.com/v1' },
  {
    id: 'dashscope',
    label: '通义千问',
    defaultHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { id: 'siliconflow', label: 'SiliconFlow', defaultHost: 'https://api.siliconflow.cn/v1' },
  { id: 'ollama', label: 'Ollama', defaultHost: 'http://localhost:11434/v1' },
  { id: 'custom', label: '自定义 (OpenAI 兼容)', defaultHost: '' },
];

const selectClassName =
  'w-full px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]';

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

export const AITab: React.FC = () => {
  const { t } = useTranslation();
  const settingsService = getSettingsService();

  const [provider, setProvider] = useState<AIProviderDTO | null>(null);
  const [chatModel, setChatModel] = useState('');
  const [completionModel, setCompletionModel] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Initial load. Picks a provider in this order: chat selection → completion
  // selection → first existing → deepseek default. Models inputs default to
  // whatever the user already selected; completion left blank means "same as
  // chat" downstream.
  useEffect(() => {
    (async () => {
      const config = await settingsService.getAIConfig();

      const chatSel = config.selectedModels.chat;
      const complSel = config.selectedModels.completion;
      const activeId: ProviderId =
        (chatSel?.providerId ?? complSel?.providerId ?? config.providers[0]?.id ?? 'deepseek') as
          ProviderId;

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

  // Placeholder host shown in the input — derived from the provider option.
  const hostPlaceholder = useMemo(() => {
    if (!provider) return 'https://...';
    return PROVIDER_OPTIONS.find((o) => o.id === provider.id)?.defaultHost ?? 'https://...';
  }, [provider]);

  if (!provider) {
    return (
      <div className="text-sm text-[var(--color-text-muted)] py-4">
        {t('aiSettings.chatProvider')}...
      </div>
    );
  }

  return (
    <>
      <SectionTitle>{t('aiSettings.chatProvider')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('aiSettings.chatProviderDesc')}
      </p>

      <SettingItem label={t('aiSettings.provider')} description={t('aiSettings.providerDesc')}>
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
      </SettingItem>

      <SettingItem label={t('aiSettings.apiKey')} description={t('aiSettings.apiKeyDesc')}>
        <input
          type="password"
          value={provider.apiKey}
          onChange={(e) => updateProvider({ apiKey: e.target.value })}
          placeholder="sk-..."
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.baseUrl')} description={t('aiSettings.baseUrlDesc')}>
        <input
          type="text"
          value={provider.apiHost}
          onChange={(e) => updateProvider({ apiHost: e.target.value })}
          placeholder={hostPlaceholder}
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.chatModel')} description={t('aiSettings.chatModelDesc')}>
        <input
          type="text"
          value={chatModel}
          onChange={(e) => setChatModel(e.target.value)}
          onBlur={() => commitChatModel(chatModel)}
          placeholder="deepseek-chat"
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.model')} description={t('aiSettings.modelDesc')}>
        <input
          type="text"
          value={completionModel}
          onChange={(e) => setCompletionModel(e.target.value)}
          onBlur={() => commitCompletionModel(completionModel)}
          placeholder={chatModel || 'gpt-4o-mini'}
          className={inputClassName}
        />
      </SettingItem>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testing || !provider.apiKey}
          className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 flex items-center gap-1.5"
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          {t('aiSettings.testConnection')}
        </button>
        {testResult && (
          <span className={`text-xs ${testResult.ok ? 'text-green-500' : 'text-red-500'}`}>
            {testResult.msg}
          </span>
        )}
      </div>
    </>
  );
};
