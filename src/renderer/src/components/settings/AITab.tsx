/**
 * @file AITab.tsx - AI Completion Settings Tab
 * @description Configures AI provider, API key, base URL and model for inline completion
 */

import { Loader2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { AIProviderDTO, SelectedModels } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import type { ProviderId } from '../../types/provider';
import { SectionTitle, SettingItem, Toggle, inputClassName } from './SettingsUI';

const PROVIDER_OPTIONS: { id: ProviderId; label: string; defaultHost: string }[] = [
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

export const AITab: React.FC = () => {
  const { t } = useTranslation();
  const settingsService = getSettingsService();

  const [provider, setProvider] = useState<AIProviderDTO | null>(null);
  const [selectedModels, setSelectedModels] = useState<SelectedModels | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [enabled, setEnabled] = useState(true);

  // Load configuration.
  useEffect(() => {
    (async () => {
      const config = await settingsService.getAIConfig();
      const models = config.selectedModels;
      setSelectedModels(models);

      // Pick the first provider with an apiKey, else the first provider, else a default empty provider.
      const active = config.providers.find((p) => p.enabled && p.apiKey) ||
        config.providers[0] || {
          id: 'openai' as ProviderId,
          name: 'OpenAI',
          apiKey: '',
          apiHost: 'https://api.openai.com/v1',
          defaultApiHost: 'https://api.openai.com/v1',
          enabled: true,
          models: [],
        };
      setProvider(active);
      setEnabled(active.enabled);

      const completionModel = models.completion?.modelId || active.models?.[0]?.id || '';
      setModelInput(completionModel);
    })();
  }, [settingsService]);

  // Persist configuration.
  const save = useCallback(
    async (updates: {
      providerId?: ProviderId;
      apiKey?: string;
      apiHost?: string;
      model?: string;
      isEnabled?: boolean;
    }) => {
      if (!provider) return;

      const updatedProvider: AIProviderDTO = {
        ...provider,
        id: updates.providerId ?? provider.id,
        name:
          PROVIDER_OPTIONS.find((o) => o.id === (updates.providerId ?? provider.id))?.label ??
          provider.name,
        apiKey: updates.apiKey ?? provider.apiKey,
        apiHost: updates.apiHost ?? provider.apiHost,
        enabled: updates.isEnabled ?? enabled,
      };

      // When switching providers, reset the host to the new provider's default.
      if (updates.providerId && updates.providerId !== provider.id) {
        const option = PROVIDER_OPTIONS.find((o) => o.id === updates.providerId);
        if (option) {
          updatedProvider.apiHost = option.defaultHost;
          updatedProvider.defaultApiHost = option.defaultHost;
        }
      }

      setProvider(updatedProvider);

      const modelId = updates.model ?? modelInput;
      const newSelectedModels: SelectedModels = {
        ...(selectedModels ?? {
          chat: null,
          completion: null,
          vision: null,
          tts: null,
          stt: null,
        }),
        completion: {
          providerId: updatedProvider.id,
          modelId,
        },
      };
      setSelectedModels(newSelectedModels);

      await settingsService.setAIConfig({
        providers: [updatedProvider],
        selectedModels: newSelectedModels,
      });
    },
    [provider, selectedModels, modelInput, enabled, settingsService]
  );

  const handleProviderChange = useCallback(
    (id: ProviderId) => {
      setTestResult(null);
      save({ providerId: id });
    },
    [save]
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

  if (!provider) {
    return (
      <div className="text-sm text-[var(--color-text-muted)] py-4">
        {t('aiSettings.completionProvider')}...
      </div>
    );
  }

  return (
    <>
      <SectionTitle>{t('aiSettings.completionProvider')}</SectionTitle>

      <Toggle
        label={t('aiSettings.enableCompletion')}
        desc={t('aiSettings.enableCompletionDesc')}
        checked={enabled}
        onChange={(v) => {
          setEnabled(v);
          save({ isEnabled: v });
        }}
      />

      <SettingItem label={t('aiSettings.provider')} description={t('aiSettings.providerDesc')}>
        <select
          value={provider.id}
          onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
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
          onChange={(e) => save({ apiKey: e.target.value })}
          placeholder="sk-..."
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.baseUrl')} description={t('aiSettings.baseUrlDesc')}>
        <input
          type="text"
          value={provider.apiHost}
          onChange={(e) => save({ apiHost: e.target.value })}
          placeholder={
            PROVIDER_OPTIONS.find((o) => o.id === provider.id)?.defaultHost || 'https://...'
          }
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.model')} description={t('aiSettings.modelDesc')}>
        <input
          type="text"
          value={modelInput}
          onChange={(e) => {
            setModelInput(e.target.value);
          }}
          onBlur={() => save({ model: modelInput })}
          placeholder="gpt-4o-mini"
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
