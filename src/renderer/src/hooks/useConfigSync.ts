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

// ====== AI Config Sync ======

/**
 * Infers SDK type from provider ID.
 * Anthropic needs its dedicated SDK; everything else goes through the OpenAI-compatible path.
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
  // When chat has no explicit selection, fall back to the completion model (user may have configured completion only).
  const chatModel =
    chatSelection?.modelId ||
    mainProvider.models?.[0]?.id ||
    selectedModels.completion?.modelId ||
    '';
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

      // Need at least one usable model (chat or completion) before syncing is worthwhile.
      if (!configPayload.model && !configPayload.completionModel) {
        logger.warn('No model selected (neither chat nor completion), skipping AI config sync');
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
