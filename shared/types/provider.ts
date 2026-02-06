/**
 * @file AI Provider Types
 * @description Shared type definitions for AI providers and models
 * @depends None (pure type definitions)
 */

// ====== Provider Types ======

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
  | `custom-${string}`;

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

// ====== Model Definition ======

export interface ModelInfo {
  id: string;
  name: string;
  type: ModelType;
  contextLength?: number;
  maxTokens?: number;
  /** Price per million tokens */
  inputPrice?: number;
  outputPrice?: number;
  capabilities?: ModelCapabilities;
  description?: string;
}

// ====== Provider Definition ======

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

// ====== Model Selection ======

export interface ModelSelection {
  providerId: ProviderId;
  modelId: string;
}

export interface SelectedModels {
  chat: ModelSelection | null;
  completion: ModelSelection | null;
  vision: ModelSelection | null;
  embedding: ModelSelection | null;
  rerank: ModelSelection | null;
  tts: ModelSelection | null;
  stt: ModelSelection | null;
}

export const DEFAULT_SELECTED_MODELS: SelectedModels = {
  chat: null,
  completion: null,
  vision: null,
  embedding: null,
  rerank: null,
  tts: null,
  stt: null,
};

// ====== AI Service Runtime Config ======

/**
 * Runtime configuration for AIService
 * Supports independent Provider credentials for Chat and Completion
 */
export interface AIServiceConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  completionProvider?: 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom';
  completionModel?: string;
  completionApiKey?: string;
  completionBaseUrl?: string;
}

// ====== Utility Functions ======

export function isSystemProvider(provider: Provider): provider is SystemProvider {
  return provider.isSystem === true;
}

export function getModelDisplayName(model: ModelInfo): string {
  return model.name || model.id;
}

export function getProviderDisplayName(provider: Provider): string {
  return provider.name || provider.id;
}
