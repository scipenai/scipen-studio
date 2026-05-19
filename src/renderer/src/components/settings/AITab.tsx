/**
 * @file AITab.tsx - AI Settings Tab
 * @description Two independent sections:
 *   - Chat (SNACA): provider/apiKey/apiHost/model for the SNACA assistant
 *   - Completion (Ctrl+K): provider/apiKey/apiHost/model for inline ghost-text
 *
 *   Credentials are deduped by `providerId`: if Chat and Completion pick the
 *   same provider, they share apiKey + apiHost; editing one side updates both.
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

type Role = 'chat' | 'completion';

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

  // Credentials keyed by providerId. Same id → one set of key/host shared
  // between Chat and Completion.
  const [providersById, setProvidersById] = useState<Record<string, AIProviderDTO>>({});
  const [chatSel, setChatSel] = useState<ModelSelection>({
    providerId: 'deepseek',
    modelId: '',
  });
  const [completionSel, setCompletionSel] = useState<ModelSelection>({
    providerId: 'openai',
    modelId: '',
  });
  const [chatModelInput, setChatModelInput] = useState('');
  const [completionModelInput, setCompletionModelInput] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Initial load.
  useEffect(() => {
    (async () => {
      const config = await settingsService.getAIConfig();

      const map: Record<string, AIProviderDTO> = {};
      for (const p of config.providers) map[p.id] = p;

      const chat: ModelSelection = config.selectedModels.chat ?? {
        providerId: (config.providers[0]?.id ?? 'deepseek') as ProviderId,
        modelId: '',
      };
      const completion: ModelSelection = config.selectedModels.completion ?? {
        providerId: chat.providerId,
        modelId: '',
      };

      // Ensure both selected providers exist in the map.
      if (!map[chat.providerId]) map[chat.providerId] = makeProvider(chat.providerId);
      if (!map[completion.providerId]) {
        map[completion.providerId] = makeProvider(completion.providerId);
      }

      setProvidersById(map);
      setChatSel(chat);
      setCompletionSel(completion);
      setChatModelInput(chat.modelId);
      setCompletionModelInput(completion.modelId);
    })();
  }, [settingsService]);

  // Build the AIConfigDTO to persist from current state.
  const persist = useCallback(
    async (next: {
      providersById?: Record<string, AIProviderDTO>;
      chatSel?: ModelSelection;
      completionSel?: ModelSelection;
    }) => {
      const pmap = next.providersById ?? providersById;
      const chat = next.chatSel ?? chatSel;
      const compl = next.completionSel ?? completionSel;

      const dto: { providers: AIProviderDTO[]; selectedModels: SelectedModels } = {
        providers: Object.values(pmap),
        selectedModels: {
          chat,
          completion: compl,
          vision: null,
          tts: null,
          stt: null,
        },
      };
      await settingsService.setAIConfig(dto);
    },
    [providersById, chatSel, completionSel, settingsService]
  );

  // ----- generic helpers wired into per-role inputs -----

  const updateCredentials = useCallback(
    (providerId: ProviderId, patch: Partial<Pick<AIProviderDTO, 'apiKey' | 'apiHost'>>) => {
      const existing = providersById[providerId] ?? makeProvider(providerId);
      const merged = { ...existing, ...patch };
      const nextMap = { ...providersById, [providerId]: merged };
      setProvidersById(nextMap);
      void persist({ providersById: nextMap });
    },
    [providersById, persist]
  );

  const changeProvider = useCallback(
    (role: Role, id: ProviderId) => {
      setTestResult(null);
      const ensured = providersById[id] ?? makeProvider(id);
      const nextMap = providersById[id] ? providersById : { ...providersById, [id]: ensured };
      if (role === 'chat') {
        const next: ModelSelection = { providerId: id, modelId: chatModelInput };
        setProvidersById(nextMap);
        setChatSel(next);
        void persist({ providersById: nextMap, chatSel: next });
      } else {
        const next: ModelSelection = { providerId: id, modelId: completionModelInput };
        setProvidersById(nextMap);
        setCompletionSel(next);
        void persist({ providersById: nextMap, completionSel: next });
      }
    },
    [providersById, chatModelInput, completionModelInput, persist]
  );

  const commitModel = useCallback(
    (role: Role, modelId: string) => {
      if (role === 'chat') {
        const next: ModelSelection = { providerId: chatSel.providerId, modelId };
        setChatSel(next);
        void persist({ chatSel: next });
      } else {
        const next: ModelSelection = { providerId: completionSel.providerId, modelId };
        setCompletionSel(next);
        void persist({ completionSel: next });
      }
    },
    [chatSel.providerId, completionSel.providerId, persist]
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

  // ----- derived: provider entry for each section -----

  const chatProvider = useMemo<AIProviderDTO>(
    () => providersById[chatSel.providerId] ?? makeProvider(chatSel.providerId),
    [providersById, chatSel.providerId]
  );
  const completionProvider = useMemo<AIProviderDTO>(
    () => providersById[completionSel.providerId] ?? makeProvider(completionSel.providerId),
    [providersById, completionSel.providerId]
  );

  return (
    <>
      {/* ========== Chat (SNACA) ========== */}
      <SectionTitle>{t('aiSettings.chatProvider')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('aiSettings.chatProviderDesc')}
      </p>

      <SettingItem label={t('aiSettings.provider')} description={t('aiSettings.providerDesc')}>
        <select
          value={chatSel.providerId}
          onChange={(e) => changeProvider('chat', e.target.value as ProviderId)}
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
          value={chatProvider.apiKey}
          onChange={(e) => updateCredentials(chatSel.providerId, { apiKey: e.target.value })}
          placeholder="sk-..."
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.baseUrl')} description={t('aiSettings.baseUrlDesc')}>
        <input
          type="text"
          value={chatProvider.apiHost}
          onChange={(e) => updateCredentials(chatSel.providerId, { apiHost: e.target.value })}
          placeholder={
            PROVIDER_OPTIONS.find((o) => o.id === chatSel.providerId)?.defaultHost ?? 'https://...'
          }
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.chatModel')} description={t('aiSettings.chatModelDesc')}>
        <input
          type="text"
          value={chatModelInput}
          onChange={(e) => setChatModelInput(e.target.value)}
          onBlur={() => commitModel('chat', chatModelInput)}
          placeholder="deepseek-chat"
          className={inputClassName}
        />
      </SettingItem>

      {/* ========== Completion (Ctrl+K) ========== */}
      <div className="mt-6" />
      <SectionTitle>{t('aiSettings.completionProvider')}</SectionTitle>

      <SettingItem label={t('aiSettings.provider')} description={t('aiSettings.providerDesc')}>
        <select
          value={completionSel.providerId}
          onChange={(e) => changeProvider('completion', e.target.value as ProviderId)}
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
          value={completionProvider.apiKey}
          onChange={(e) => updateCredentials(completionSel.providerId, { apiKey: e.target.value })}
          placeholder="sk-..."
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.baseUrl')} description={t('aiSettings.baseUrlDesc')}>
        <input
          type="text"
          value={completionProvider.apiHost}
          onChange={(e) =>
            updateCredentials(completionSel.providerId, { apiHost: e.target.value })
          }
          placeholder={
            PROVIDER_OPTIONS.find((o) => o.id === completionSel.providerId)?.defaultHost ??
            'https://...'
          }
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('aiSettings.model')} description={t('aiSettings.modelDesc')}>
        <input
          type="text"
          value={completionModelInput}
          onChange={(e) => setCompletionModelInput(e.target.value)}
          onBlur={() => commitModel('completion', completionModelInput)}
          placeholder="gpt-4o-mini"
          className={inputClassName}
        />
      </SettingItem>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testing || !completionProvider.apiKey}
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
