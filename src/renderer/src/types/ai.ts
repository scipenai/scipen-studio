/**
 * @file ai.ts - AI-related type definitions
 * @description Defines types for AI messages, citation sources, and model configurations
 */

/** AI message role */
export type AIMessageRole = 'user' | 'assistant' | 'system';

/** AI citation source */
export interface AICitation {
  id: string;
  content: string;
  source: string;
  page?: number;
  timestamp?: number;
  score: number;
}

/**
 * AI message - unified definition
 *
 * Used for AI conversations, streaming responses, etc.
 * Note: For simplified version (only role + content) when calling API,
 * can use Pick<AIMessage, 'role' | 'content'>
 */
export interface AIMessage {
  id: string;
  role: AIMessageRole;
  content: string;
  timestamp: number;
  citations?: AICitation[];
  searchTime?: number;
}

/** AI message - simplified version for API calls */
export type AIMessageSimple = Pick<AIMessage, 'role' | 'content'>;

/** AI provider type */
export type AIProvider = 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom';

/** VLM provider type */
export type VLMProvider = 'openai' | 'anthropic' | 'ollama' | 'custom';

/** Whisper provider type */
export type WhisperProvider = 'openai' | 'custom';

/** Embedding provider type */
export type EmbeddingProvider = 'openai' | 'ollama' | 'custom';

/** AI configuration */
export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Independent completion configuration
  completionModel?: string;
  completionApiKey?: string; // Independent API Key, uses main apiKey if not set
  completionBaseUrl?: string; // Independent Base URL, uses main baseUrl if not set
}

/** Streaming response callbacks */
export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: (fullResponse: string) => void;
  onError: (error: Error) => void;
}

/** AI chat session */
export interface ChatSession {
  id: string;
  title: string;
  messages: AIMessage[];
  createdAt: number;
  updatedAt: number;
}
