/**
 * @file provider.ts - AI provider type definitions
 * @description Defines core types for AI providers, model information, and capability configurations
 */

// ============ Provider Types ============

/** Provider ID */
export type ProviderId =
  | 'siliconflow'
  | 'aihubmix'
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'dashscope'
  | 'zhipu'
  | 'moonshot'
  | 'ollama'
  | 'custom'
  | `custom-${string}`; // 🔧 Supports dynamic custom provider id (e.g., custom-1737453600000)

export type ModelType = 'chat' | 'completion' | 'vision' | 'embedding' | 'rerank' | 'tts' | 'stt';

export interface ModelCapabilities {
  chat?: boolean;
  completion?: boolean;
  vision?: boolean;
  embedding?: boolean;
  rerank?: boolean;
  tts?: boolean;
  stt?: boolean;
  functionCall?: boolean;
  streaming?: boolean;
}

// ============ Model Definitions ============

export interface ModelInfo {
  id: string;
  name: string;
  type: ModelType;
  contextLength?: number;
  maxTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  capabilities?: ModelCapabilities;
  description?: string;
}

// ============ Provider Definitions ============

export interface Provider {
  id: ProviderId;
  name: string;
  apiKey: string;
  apiHost: string;
  defaultApiHost?: string;
  enabled: boolean;
  isSystem?: boolean;
  models: ModelInfo[];
  website?: string;
  anthropicApiHost?: string;
  timeout?: number;
  rateLimit?: number;
}

export interface SystemProvider extends Provider {
  isSystem: true;
  logo?: string;
  websites?: {
    official?: string;
    apiKey?: string;
    docs?: string;
    models?: string;
  };
}

// ============ Model Selection ============

export interface SelectedModels {
  chat: { providerId: ProviderId; modelId: string } | null;
  completion: { providerId: ProviderId; modelId: string } | null;
  vision: { providerId: ProviderId; modelId: string } | null;
  embedding: { providerId: ProviderId; modelId: string } | null;
  rerank: { providerId: ProviderId; modelId: string } | null;
  tts: { providerId: ProviderId; modelId: string } | null;
  stt: { providerId: ProviderId; modelId: string } | null;
}

// ============ Utility Functions ============

export function isSystemProvider(provider: Provider): provider is SystemProvider {
  return provider.isSystem === true;
}

export function getModelDisplayName(model: ModelInfo): string {
  return model.name || model.id;
}

export function getProviderDisplayName(provider: Provider): string {
  return provider.name || provider.id;
}
