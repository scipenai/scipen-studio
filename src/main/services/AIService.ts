/**
 * @file AIService - Main process AI service
 * @description Unified multi-provider management using Vercel AI SDK
 * @supports OpenAI, Anthropic, DeepSeek, Ollama, etc.
 * @implements IAIService for dependency injection via ServiceContainer
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel, generateText, streamText } from 'ai';
import { createLogger } from './LoggerService';
import type { AIConfig, AIMessage, IAIService, StreamChunk } from './interfaces/IAIService';

const logger = createLogger('AIService');

/**
 * @remarks Re-exported for backward compatibility.
 */
export type { AIConfig, AIMessage, StreamChunk } from './interfaces/IAIService';

// ====== System Prompts ======
const COMPLETION_SYSTEM_PROMPT = `You are a professional scientific writing assistant. Your task is to continue writing content based on the given context.

You support both LaTeX (.tex) and Typst (.typ) documents:
- For LaTeX: Use standard LaTeX commands like \\section{}, \\begin{}, \\cite{}, etc.
- For Typst: Use Typst syntax like = for headings, #set, #show, @cite, etc.

Requirements:
1. Continue writing naturally based on the context
2. Maintain consistent style and formatting
3. Use appropriate commands and syntax for the detected format
4. Keep the content academically rigorous
5. Return only the continuation, not the original context`;

const CHAT_SYSTEM_PROMPT = `You are SciPen AI, a professional scientific writing assistant specializing in LaTeX, Typst, and academic writing.

Capabilities:
1. Help with LaTeX syntax and commands
2. Help with Typst syntax and functions
3. Assist with mathematical formulas (both LaTeX and Typst math syntax)
4. Provide writing suggestions
5. Answer questions about scientific writing
6. Help with document structure and formatting

LaTeX uses: \\command{}, \\begin{env}...\\end{env}, $math$, \\cite{key}
Typst uses: #function(), = headings, $math$, @cite

Always provide clear, concise, and academically appropriate responses.`;

// ====== AIService Implementation ======
/**
 * @remarks Issues network requests to AI providers and may stream responses.
 * @throws Error when API configuration is missing or provider initialization fails.
 * @sideeffect Maintains streaming state and active abort controller.
 */
export class AIService implements IAIService {
  private currentConfig: AIConfig | null = null;
  private currentAbortController: AbortController | null = null;
  private _isStreaming = false;

  private createModel(modelId?: string): LanguageModel {
    if (!this.currentConfig) {
      throw new Error('AI API Key not configured');
    }

    const { provider, apiKey, baseUrl } = this.currentConfig;
    const model = modelId || this.currentConfig.model;

    switch (provider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: baseUrl || undefined,
        });
        return anthropic(model);
      }
      default: {
        // All OpenAI-compatible providers use createOpenAI
        const openai = createOpenAI({
          apiKey,
          baseURL: normalizeOpenAIBaseUrl(baseUrl),
        });
        // Use .chat() to ensure Chat Completions API instead of new Responses API
        // (many compatible services don't support Responses API)
        return openai.chat(model);
      }
    }
  }

  /**
   * Create language model for completion tasks.
   * Uses completionProvider to select correct SDK, allowing Chat=Anthropic + Completion=OpenAI
   * configurations to work properly. Falls back to main credentials if not set.
   */
  private createCompletionModel(): LanguageModel {
    if (!this.currentConfig) {
      throw new Error('AI API Key not configured');
    }

    const {
      provider,
      apiKey,
      baseUrl,
      model,
      completionProvider,
      completionModel,
      completionApiKey,
      completionBaseUrl,
    } = this.currentConfig;

    const effectiveApiKey = completionApiKey || apiKey;
    const effectiveBaseUrl = completionBaseUrl || baseUrl;
    const effectiveModel = completionModel || model;
    // Use completionProvider for SDK selection to support mixed provider configs
    const effectiveProvider = completionProvider || provider;

    switch (effectiveProvider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey: effectiveApiKey,
          baseURL: effectiveBaseUrl || undefined,
        });
        return anthropic(effectiveModel);
      }
      default: {
        const openai = createOpenAI({
          apiKey: effectiveApiKey,
          baseURL: normalizeOpenAIBaseUrl(effectiveBaseUrl),
        });
        return openai.chat(effectiveModel);
      }
    }
  }

  /** Update AI configuration */
  updateConfig(config: AIConfig): void {
    // Require at least one API key (main key or completion-only key)
    if (!config.apiKey && !config.completionApiKey) {
      console.warn('[AIService] API Key not configured');
      this.currentConfig = null;
      return;
    }

    this.currentConfig = config;
    logger.info(
      `[AIService] Config updated: ${config.provider} ${config.baseUrl} model=${config.model} completionModel=${config.completionModel || '(same)'}`
    );
  }

  /** Get current configuration */
  getConfig(): AIConfig | null {
    return this.currentConfig;
  }

  /** Check if AI is configured */
  isConfigured(): boolean {
    if (!this.currentConfig) return false;
    return !!(this.currentConfig.apiKey || this.currentConfig.completionApiKey);
  }

  /**
   * AI text completion.
   * Uses separate completion config if set, allowing different providers for completion tasks.
   */
  async getCompletion(context: string): Promise<string> {
    const model = this.createCompletionModel();

    try {
      const { text } = await generateText({
        model,
        system: COMPLETION_SYSTEM_PROMPT,
        prompt: `Continue writing the following content:\n\n${context}`,
        maxOutputTokens: 256,
        temperature: 0.7,
      });

      return text;
    } catch (error) {
      console.error('[AIService] Completion failed:', error);
      throw error;
    }
  }

  /** AI chat (non-streaming, used internally by ChatOrchestrator) */
  async chat(messages: AIMessage[]): Promise<string> {
    const model = this.createModel();

    const systemPrompt = this.resolveSystemPrompt(messages, CHAT_SYSTEM_PROMPT);

    const formattedMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        messages: formattedMessages,
        maxOutputTokens: this.currentConfig?.maxTokens || 4096,
        temperature: this.currentConfig?.temperature || 0.7,
      });

      return text;
    } catch (error) {
      console.error('[AIService] Chat failed:', error);
      throw error;
    }
  }

  /** AI chat (streaming) - returns async generator, supports cancellation */
  async *chatStream(messages: AIMessage[]): AsyncGenerator<StreamChunk> {
    if (!this.currentConfig) {
      yield { type: 'error', error: 'AI API Key not configured' };
      return;
    }

    // Cancel any in-progress request before starting new one
    if (this._isStreaming) {
      this.stopGeneration();
    }

    this.currentAbortController = new AbortController();
    this._isStreaming = true;

    const systemPrompt = this.resolveSystemPrompt(messages, CHAT_SYSTEM_PROMPT);

    const formattedMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    let fullResponse = '';

    try {
      const model = this.createModel();

      const result = streamText({
        model,
        system: systemPrompt,
        messages: formattedMessages,
        maxOutputTokens: this.currentConfig.maxTokens,
        temperature: this.currentConfig.temperature,
        abortSignal: this.currentAbortController.signal,
      });

      for await (const textPart of result.textStream) {
        if (this.currentAbortController?.signal.aborted) {
          logger.info('[AIService] Stream aborted by user');
          yield { type: 'complete', content: `${fullResponse}\n\n[Generation stopped]` };
          return;
        }

        if (textPart) {
          fullResponse += textPart;
          yield { type: 'chunk', content: textPart };
        }
      }

      yield { type: 'complete', content: fullResponse };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('[AIService] Stream aborted');
        yield { type: 'complete', content: fullResponse || '[Generation stopped]' };
        return;
      }

      let errorMessage = error instanceof Error ? error.message : String(error);

      // Map common API errors to user-friendly messages
      if (errorMessage.includes('insufficient') || errorMessage.includes('balance')) {
        errorMessage = 'Insufficient balance, please top up';
      } else if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
        errorMessage = 'Rate limit exceeded, please retry later';
      } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        errorMessage = 'Invalid or expired API Key';
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        errorMessage = 'Request timeout, check network connection';
      }

      logger.error('[AIService] Stream chat failed:', error);
      yield { type: 'error', error: errorMessage };
    } finally {
      this._isStreaming = false;
      this.currentAbortController = null;
    }
  }

  /** Stop current AI generation */
  stopGeneration(): boolean {
    if (this.currentAbortController && this._isStreaming) {
      logger.info('[AIService] Stopping generation...');
      this.currentAbortController.abort();
      this.currentAbortController = null;
      this._isStreaming = false;
      return true;
    }
    return false;
  }

  /**
   * Resolve system prompt from messages (fallback if not provided).
   */
  private resolveSystemPrompt(messages: AIMessage[], fallback: string): string {
    const systemMessages = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content.trim())
      .filter(Boolean);

    return systemMessages.length > 0 ? systemMessages.join('\n\n') : fallback;
  }

  /** Check if generation is in progress */
  isGenerating(): boolean {
    return this._isStreaming;
  }

  /** Test AI connection */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.currentConfig) {
      return { success: false, message: 'AI API Key not configured' };
    }

    logger.info('[AIService] Testing connection:');
    logger.info('  - Provider:', this.currentConfig.provider);
    logger.info('  - Base URL:', this.currentConfig.baseUrl);
    logger.info('  - Model:', this.currentConfig.model);
    logger.info('  - API Key (first 4):', `${this.currentConfig.apiKey.substring(0, 4)}***`);

    try {
      const model = this.createModel();

      const { text } = await generateText({
        model,
        prompt: 'Hello',
        maxOutputTokens: 10,
      });

      if (text) {
        return { success: true, message: `Connected! Model: ${this.currentConfig.model}` };
      }

      return { success: false, message: 'Connection failed: no response' };
    } catch (error: unknown) {
      console.error('[AIService] Connection test failed:', error);

      let message = 'Unknown error';
      const apiError = error as { status?: number; message?: string };
      if (apiError?.status === 401) {
        message = `Auth failed (401): Check API Key. Base URL: ${this.currentConfig.baseUrl}`;
      } else if (apiError?.status === 404) {
        message = `Model not found (404): Check model name "${this.currentConfig.model}"`;
      } else if (apiError?.message) {
        message = apiError.message;
      }

      return { success: false, message: `Connection failed: ${message}` };
    }
  }
}

/**
 * Vercel `@ai-sdk/openai` concatenates `{baseURL}/chat/completions`
 * verbatim — it does NOT auto-append `/v1`. Users routinely paste
 * `https://api.deepseek.com` (or trailing-slashed variants) into the
 * Settings field; SNACA's clients tolerate both forms, so AIService
 * does too. Anthropic SDK handles its own versioning, hence this only
 * runs on the OpenAI-compatible path.
 *
 * @internal Exported for unit tests.
 */
export function normalizeOpenAIBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  // Already ends in `/v1`, `/v2`, etc. — leave it.
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

/**
 * @remarks Returns a fresh instance for ServiceContainer registration.
 */
export function createAIService(): IAIService {
  return new AIService();
}

/**
 * @remarks Singleton instance for direct import (backward compatibility).
 */
export const aiService: IAIService = new AIService();
