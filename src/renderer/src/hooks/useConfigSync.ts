/**
 * @file useConfigSync.ts - Config sync Hook
 * @description Syncs AI config panel settings to backend services, all AI-related configs are read from SettingsService
 * @depends api, LogService, SettingsService, useSettings
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIProviderDTO } from '../api';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { getSettingsService } from '../services/core/ServiceRegistry';
import type { ProviderId } from '../types/provider';
import { useSettings } from './useSettings';

const logger = createLogger('ConfigSync');

// ====== Helper Functions ======

function getProviderById(
  providers: AIProviderDTO[],
  providerId: ProviderId
): AIProviderDTO | undefined {
  return providers.find((p) => p.id === providerId);
}

function getEnabledProvider(providers: AIProviderDTO[]): AIProviderDTO | undefined {
  return providers.find((p) => p.enabled && p.apiKey);
}

function getProviderBaseUrl(provider: AIProviderDTO): string {
  return provider.apiHost || provider.defaultApiHost || 'https://api.openai.com/v1';
}

// ====== Knowledge Config Sync ======

/**
 * Syncs knowledge base config (VLM/Whisper/Embedding/RAG) to backend.
 * Only syncs when config actually changes to avoid unnecessary IPC.
 *
 * @sideeffect Calls api.knowledge.updateConfig and api.knowledge.setAdvancedConfig
 */
export function useKnowledgeConfigSync() {
  const [configVersion, setConfigVersion] = useState(0);
  const lastSyncedConfigRef = useRef<string>('');
  const lastSyncedAdvancedConfigRef = useRef<string>('');

  const ragAdvanced = useSettings((s) => s.rag?.advanced);

  useEffect(() => {
    const settingsService = getSettingsService();
    const disposable = settingsService.onDidChangeAIProviders(() => {
      setConfigVersion((v) => v + 1);
    });

    return () => {
      disposable.dispose();
    };
  }, []);

  const syncConfig = useCallback(async () => {
    try {
      const settingsService = getSettingsService();
      const config = await settingsService.getAIConfig();

      if (!config.providers || config.providers.length === 0) {
        logger.debug('AI config not found, skipping knowledge config sync');
        return;
      }

      const { providers, selectedModels } = config;
      const mainProvider = getEnabledProvider(providers);

      if (!mainProvider?.apiKey) {
        logger.debug('No valid API key, skipping knowledge config sync');
        return;
      }

      // Embedding model
      const embeddingSelection = selectedModels.embedding;
      const embeddingProvider = embeddingSelection
        ? getProviderById(providers, embeddingSelection.providerId)
        : mainProvider;
      const embeddingApiKey = embeddingProvider?.apiKey || mainProvider.apiKey;
      const embeddingBaseUrl = embeddingProvider
        ? getProviderBaseUrl(embeddingProvider)
        : getProviderBaseUrl(mainProvider);
      const embeddingModel = embeddingSelection?.modelId || 'text-embedding-3-small';

      // VLM (Vision) model
      const visionSelection = selectedModels.vision;
      const visionProvider = visionSelection
        ? getProviderById(providers, visionSelection.providerId)
        : mainProvider;
      const vlmApiKey = visionProvider?.apiKey || mainProvider.apiKey;
      const vlmBaseUrl = visionProvider
        ? getProviderBaseUrl(visionProvider)
        : getProviderBaseUrl(mainProvider);
      const vlmModel = visionSelection?.modelId || 'gpt-4o';

      // STT (Whisper) model
      const sttSelection = selectedModels.stt;
      const sttProvider = sttSelection
        ? getProviderById(providers, sttSelection.providerId)
        : mainProvider;
      const whisperApiKey = sttProvider?.apiKey || mainProvider.apiKey;
      const whisperBaseUrl = sttProvider
        ? getProviderBaseUrl(sttProvider)
        : getProviderBaseUrl(mainProvider);
      const whisperModel = sttSelection?.modelId || 'whisper-1';

      // Chat model (LLM)
      const chatSelection = selectedModels.chat;
      const chatProvider = chatSelection
        ? getProviderById(providers, chatSelection.providerId)
        : mainProvider;
      const llmApiKey = chatProvider?.apiKey || mainProvider.apiKey;
      const llmBaseUrl = chatProvider
        ? getProviderBaseUrl(chatProvider)
        : getProviderBaseUrl(mainProvider);
      const llmModel = chatSelection?.modelId || 'gpt-4o';

      // Why provider type mapping: Ollama uses different API format, others use OpenAI-compatible
      const embeddingProviderId = embeddingSelection?.providerId || mainProvider.id;
      const visionProviderId = visionSelection?.providerId || mainProvider.id;

      const getKnowledgeProviderType = (providerId: string) => {
        if (providerId === 'ollama') return 'ollama';
        if (providerId === 'local') return 'local';
        return 'openai'; // Default to OpenAI-compatible mode
      };

      const configPayload = {
        embeddingProvider: getKnowledgeProviderType(embeddingProviderId),
        embeddingApiKey,
        embeddingBaseUrl,
        embeddingModel,
        vlmProvider: getKnowledgeProviderType(visionProviderId),
        vlmApiKey,
        vlmBaseUrl,
        vlmModel,
        whisperApiKey,
        whisperBaseUrl,
        whisperModel,
        whisperLanguage: 'auto',
        llmApiKey,
        llmBaseUrl,
        llmModel,
      };

      const configHash = JSON.stringify(configPayload);
      if (configHash === lastSyncedConfigRef.current) {
        return;
      }

      await api.knowledge.updateConfig(configPayload);
      lastSyncedConfigRef.current = configHash;
      logger.info('Knowledge API config synced');
    } catch (error) {
      logger.error('Failed to sync knowledge config:', error);
    }
  }, []);

  const syncAdvancedConfig = useCallback(async () => {
    if (!ragAdvanced || !api.knowledge?.setAdvancedConfig) {
      return;
    }

    try {
      const advancedPayload = {
        enableQueryRewrite: ragAdvanced.enableQueryRewrite ?? false,
        enableRerank: ragAdvanced.enableRerank ?? false,
        enableContextRouting: ragAdvanced.enableContextRouting ?? false,
        enableBilingualSearch: ragAdvanced.enableBilingualSearch ?? false,
        rerankProvider: ragAdvanced.rerankProvider,
        rerankModel: ragAdvanced.rerankModel,
        rerankApiKey: ragAdvanced.rerankApiKey,
        rerankBaseUrl: ragAdvanced.rerankBaseUrl,
      };

      const advancedHash = JSON.stringify(advancedPayload);
      if (advancedHash === lastSyncedAdvancedConfigRef.current) {
        return;
      }

      await api.knowledge.setAdvancedConfig(advancedPayload);
      lastSyncedAdvancedConfigRef.current = advancedHash;
      logger.info('Knowledge advanced retrieval config synced');
    } catch (error) {
      logger.error('Failed to sync advanced retrieval config:', error);
    }
  }, [ragAdvanced]);

  useEffect(() => {
    syncConfig();
  }, [syncConfig, configVersion]);

  useEffect(() => {
    syncAdvancedConfig();
  }, [syncAdvancedConfig]);
}

// ====== AI Config Sync ======

/**
 * Infers SDK type from provider ID.
 * Why: Anthropic requires dedicated SDK, others use OpenAI-compatible mode.
 */
function inferProviderType(
  providerId: string
): 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom' {
  if (providerId === 'anthropic') return 'anthropic';
  if (providerId === 'deepseek') return 'deepseek';
  if (providerId === 'dashscope') return 'dashscope';
  if (providerId === 'ollama') return 'ollama';
  return 'custom';
}

/**
 * Builds runtime config for AIService from providers and selected models.
 * Supports independent credentials for Chat vs Completion.
 */
function buildAIServiceConfig(
  providers: AIProviderDTO[],
  selectedModels: import('../api').SelectedModels,
  mainProvider: AIProviderDTO,
  aiSettings?: { temperature?: number; maxTokens?: number }
): {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  completionProvider?: string;
  completionModel?: string;
  completionApiKey?: string;
  completionBaseUrl?: string;
} {
  const chatSelection = selectedModels.chat;
  const chatProvider = chatSelection
    ? getProviderById(providers, chatSelection.providerId)
    : mainProvider;
  const chatApiKey = chatProvider?.apiKey || mainProvider.apiKey;
  const chatBaseUrl = chatProvider
    ? getProviderBaseUrl(chatProvider)
    : getProviderBaseUrl(mainProvider);

  const chatProviderId = chatSelection?.providerId || mainProvider.id;
  const chatModel = chatSelection?.modelId || mainProvider.models?.[0]?.id || '';
  const providerType = inferProviderType(chatProviderId);

  const completionSelection = selectedModels.completion;
  let completionProviderType: string | undefined;
  let completionModel: string | undefined;
  let completionApiKey: string | undefined;
  let completionBaseUrl: string | undefined;

  if (completionSelection) {
    completionModel = completionSelection.modelId;

    const completionProviderObj = getProviderById(providers, completionSelection.providerId);
    if (completionProviderObj) {
      // Why separate provider type: Ensures correct SDK (Anthropic vs OpenAI) for completion
      completionProviderType = inferProviderType(completionSelection.providerId);

      if (completionSelection.providerId !== chatSelection?.providerId) {
        completionApiKey = completionProviderObj.apiKey;
        completionBaseUrl = getProviderBaseUrl(completionProviderObj);
      }
    }
  }

  return {
    provider: providerType,
    apiKey: chatApiKey,
    baseUrl: chatBaseUrl,
    model: chatModel,
    temperature: aiSettings?.temperature ?? 0.7,
    maxTokens: aiSettings?.maxTokens ?? 4096,
    completionProvider: completionProviderType || providerType,
    completionModel: completionModel || chatModel,
    completionApiKey,
    completionBaseUrl,
  };
}

/**
 * Syncs AI config (chat model, provider) to backend.
 * Only syncs when config actually changes.
 *
 * @sideeffect Calls api.ai.updateConfig
 */
export function useAIConfigSync() {
  const [configVersion, setConfigVersion] = useState(0);
  const lastSyncedConfigRef = useRef<string>('');

  useEffect(() => {
    const settingsService = getSettingsService();
    const disposable = settingsService.onDidChangeAIProviders(() => {
      setConfigVersion((v) => v + 1);
    });

    return () => {
      disposable.dispose();
    };
  }, []);

  const syncConfig = useCallback(async () => {
    try {
      const settingsService = getSettingsService();
      const config = await settingsService.getAIConfig();

      if (!config.providers || config.providers.length === 0) {
        logger.debug('AI config not found, skipping sync');
        return;
      }

      const { providers, selectedModels } = config;
      const mainProvider = getEnabledProvider(providers);

      if (!mainProvider?.apiKey) {
        logger.debug('No valid API key, skipping AI config sync');
        return;
      }

      const settings = settingsService.getSettings();
      const aiSettings = {
        temperature: settings.ai?.temperature,
        maxTokens: settings.ai?.maxTokens,
      };

      const configPayload = buildAIServiceConfig(
        providers,
        selectedModels,
        mainProvider,
        aiSettings
      );

      // Prevent empty model causing AIService errors
      if (!configPayload.model) {
        logger.warn('No chat model selected, skipping AI config sync');
        return;
      }

      const configHash = JSON.stringify(configPayload);
      if (configHash === lastSyncedConfigRef.current) {
        return;
      }

      await api.ai.updateConfig(configPayload);
      lastSyncedConfigRef.current = configHash;
      logger.info('AI config synced to backend');
    } catch (error) {
      logger.error('Failed to sync AI config:', error);
    }
  }, []);

  useEffect(() => {
    syncConfig();
  }, [syncConfig, configVersion]);
}
