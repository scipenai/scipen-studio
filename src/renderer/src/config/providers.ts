/**
 * @file providers.ts - Preset provider configurations
 * @description Defines configuration information for common AI providers such as SiliconFlow and AiHubMix
 */

import type { ModelInfo, SystemProvider } from '../types/provider';

// ============ Provider Brand Colors ============

export const PROVIDER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  siliconflow: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' },
  aihubmix: { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/30' },
  deepseek: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  openai: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  dashscope: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/30' },
  ollama: { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/30' },
  anthropic: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30' },
  zhipu: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', border: 'border-indigo-500/30' },
  moonshot: { bg: 'bg-violet-500/20', text: 'text-violet-400', border: 'border-violet-500/30' },
  custom: { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30' },
};

export function getProviderColor(id: string) {
  return PROVIDER_COLORS[id] || PROVIDER_COLORS.custom;
}

// ============ Preset Models ============

/** SiliconFlow models - verified 2026-02 */
const SILICONFLOW_MODELS: ModelInfo[] = [
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B', type: 'chat', contextLength: 32768 },
  { id: 'Qwen/Qwen2.5-32B-Instruct', name: 'Qwen2.5 32B', type: 'chat', contextLength: 32768 },
  { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5 7B', type: 'chat', contextLength: 32768 },
  { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', type: 'chat', contextLength: 65536 },
  { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', type: 'chat', contextLength: 65536 },
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    name: 'Qwen2.5 Coder 32B',
    type: 'completion',
    contextLength: 32768,
  },
  {
    id: 'Qwen/Qwen2.5-Coder-7B-Instruct',
    name: 'Qwen2.5 Coder 7B',
    type: 'completion',
    contextLength: 32768,
  },
  // Fix: InternVL2-26B is discontinued, switched to Qwen2.5-VL
  {
    id: 'Qwen/Qwen2.5-VL-72B-Instruct',
    name: 'Qwen2.5 VL 72B',
    type: 'vision',
    contextLength: 32768,
  },
  { id: 'Qwen/Qwen2-VL-72B-Instruct', name: 'Qwen2 VL 72B', type: 'vision', contextLength: 32768 },
  { id: 'BAAI/bge-m3', name: 'BGE M3', type: 'embedding' },
  { id: 'BAAI/bge-large-zh-v1.5', name: 'BGE Large ZH', type: 'embedding' },
  { id: 'BAAI/bge-reranker-v2-m3', name: 'BGE Reranker M3', type: 'rerank' },
  { id: 'FunAudioLLM/SenseVoiceSmall', name: 'SenseVoice', type: 'stt' },
];

/** AiHubMix models - verified 2026-02 */
const AIHUBMIX_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', type: 'chat', contextLength: 128000 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', type: 'chat', contextLength: 128000 },
  { id: 'gpt-4.1', name: 'GPT-4.1', type: 'chat', contextLength: 128000 },
  { id: 'o1', name: 'o1', type: 'chat', contextLength: 200000 },
  { id: 'o1-mini', name: 'o1 Mini', type: 'chat', contextLength: 128000 },
  { id: 'o3-mini', name: 'o3 Mini', type: 'chat', contextLength: 200000 },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    type: 'chat',
    contextLength: 200000,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    type: 'chat',
    contextLength: 200000,
  },
  { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', type: 'chat', contextLength: 200000 },
  { id: 'claude-opus-4-0', name: 'Claude Opus 4', type: 'chat', contextLength: 200000 },
  { id: 'DeepSeek-R1', name: 'DeepSeek R1', type: 'chat', contextLength: 65536 },
  { id: 'DeepSeek-V3.1-Fast', name: 'DeepSeek V3.1 Fast', type: 'chat', contextLength: 65536 },
  { id: 'gpt-4o-image', name: 'GPT-4o Vision', type: 'vision', contextLength: 128000 },
  { id: 'deepseek-ai/deepseek-vl2', name: 'DeepSeek VL2', type: 'vision', contextLength: 32768 },
  { id: 'text-embedding-3-small', name: 'Embedding 3 Small', type: 'embedding' },
  { id: 'text-embedding-3-large', name: 'Embedding 3 Large', type: 'embedding' },
  { id: 'jina-embeddings-v3', name: 'Jina Embeddings V3', type: 'embedding' },
  { id: 'whisper-1', name: 'Whisper 1', type: 'stt' },
  { id: 'whisper-large-v3', name: 'Whisper Large V3', type: 'stt' },
  { id: 'jina-reranker-v3', name: 'Jina Reranker V3', type: 'rerank' },
  { id: 'gte-rerank-v2', name: 'GTE Rerank V2', type: 'rerank' },
];

// ============ System Provider Configuration ============

export const SYSTEM_PROVIDERS: Record<string, SystemProvider> = {
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow',
    apiKey: '',
    apiHost: 'https://api.siliconflow.cn/v1',
    defaultApiHost: 'https://api.siliconflow.cn/v1',
    website: 'https://cloud.siliconflow.cn/account/ak',
    enabled: false,
    isSystem: true,
    models: SILICONFLOW_MODELS,
    websites: {
      official: 'https://siliconflow.cn',
      apiKey: 'https://cloud.siliconflow.cn/account/ak',
      docs: 'https://docs.siliconflow.cn',
      models: 'https://siliconflow.cn/models',
    },
  },
  aihubmix: {
    id: 'aihubmix',
    name: 'AiHubMix',
    apiKey: '',
    apiHost: 'https://aihubmix.com/v1',
    defaultApiHost: 'https://aihubmix.com/v1',
    website: 'https://aihubmix.com/token',
    enabled: false,
    isSystem: true,
    models: AIHUBMIX_MODELS,
    websites: {
      official: 'https://aihubmix.com',
      apiKey: 'https://aihubmix.com/token',
      docs: 'https://doc.aihubmix.com',
      models: 'https://aihubmix.com/models',
    },
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    apiKey: 'ollama',
    apiHost: 'http://localhost:11434/v1',
    defaultApiHost: 'http://localhost:11434/v1',
    website: 'https://ollama.ai',
    enabled: false,
    isSystem: true,
    models: [],
    websites: {
      official: 'https://ollama.ai',
      docs: 'https://github.com/ollama/ollama',
    },
  },
};

/** Get all system providers */
export function getSystemProviders(): SystemProvider[] {
  return Object.values(SYSTEM_PROVIDERS);
}

/** Get system provider by ID */
export function getSystemProvider(id: string): SystemProvider | undefined {
  return SYSTEM_PROVIDERS[id];
}
