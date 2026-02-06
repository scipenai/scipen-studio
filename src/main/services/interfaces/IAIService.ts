/**
 * @file IAIService - AI service contract
 * @description Public interface for AI services used by IPC handlers
 * @depends AIService
 */

import type { IDisposable } from '../ServiceContainer';

/**
 * AI configuration.
 *
 * Supports separate provider credentials for chat and completion so users can
 * route different tasks to different providers.
 */
export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Completion-specific overrides.
  completionProvider?: 'openai' | 'anthropic' | 'deepseek' | 'dashscope' | 'ollama' | 'custom'; // Separate provider type.
  completionModel?: string;
  completionApiKey?: string; // Separate API key, falls back to apiKey.
  completionBaseUrl?: string; // Separate base URL, falls back to baseUrl.
}

/**
 * AI chat message.
 */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Streaming response chunk.
 */
export interface StreamChunk {
  type: 'chunk' | 'complete' | 'error';
  content?: string;
  error?: string;
}

/**
 * AI service interface.
 */
export interface IAIService extends Partial<IDisposable> {
  /**
   * Updates AI configuration.
   * @sideeffect Reconfigures provider clients
   */
  updateConfig(config: AIConfig): void;

  /**
   * Returns current configuration.
   */
  getConfig(): AIConfig | null;

  /**
   * Checks whether AI service is configured.
   */
  isConfigured(): boolean;

  /**
   * Generates text completion.
   */
  getCompletion(context: string): Promise<string>;

  /**
   * Polishes text with optional RAG context.
   */
  polishText(text: string, ragContext?: string): Promise<string>;

  /**
   * Runs a non-streaming chat completion.
   */
  chat(messages: AIMessage[]): Promise<string>;

  /**
   * Runs a streaming chat completion.
   */
  chatStream(messages: AIMessage[]): AsyncGenerator<StreamChunk>;

  /**
   * Stops the current AI generation.
   * @sideeffect Cancels in-flight requests if supported
   */
  stopGeneration(): boolean;

  /**
   * Checks whether generation is in progress.
   */
  isGenerating(): boolean;

  /**
   * Generates a math formula.
   */
  generateFormula(description: string, format?: 'latex' | 'typst'): Promise<string>;

  /**
   * Reviews a document.
   */
  reviewDocument(content: string): Promise<string>;

  /**
   * Tests AI connectivity.
   */
  testConnection(): Promise<{ success: boolean; message: string }>;
}
