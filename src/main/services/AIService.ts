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

const POLISH_SYSTEM_PROMPT = `You are a professional academic writing editor. Your task is to polish and improve scientific document content while preserving its meaning.

You support both LaTeX and Typst formats:
- Preserve all LaTeX commands (\\command{}) and environments
- Preserve all Typst syntax (#functions, = headings, etc.)

Requirements:
1. Improve clarity and readability
2. Fix grammar and spelling errors
3. Enhance academic tone
4. Preserve all markup commands and structure
5. Return only the polished text`;

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

const FORMULA_SYSTEM_PROMPT = `You are a mathematical formula expert for scientific writing. Generate accurate formulas based on descriptions.

You support both LaTeX and Typst:
- LaTeX: Use standard LaTeX math syntax (\\frac{}{}, \\sum, \\int, etc.)
- Typst: Use Typst math syntax (frac(), sum, integral, etc.)

Requirements:
1. Use correct syntax for the requested format
2. Choose appropriate math environments
3. Ensure formulas are complete and compilable
4. Return only the code without explanations

For LaTeX, use $...$ for inline and \\[...\\] for display formulas.
For Typst, use $...$ for both inline and display math.`;

const REVIEW_SYSTEM_PROMPT = `You are an experienced academic reviewer. Provide constructive feedback on scientific documents.

You can review both LaTeX and Typst documents:
- Check LaTeX commands and environments usage
- Check Typst functions and syntax usage

Focus on:
1. Document structure and organization
2. Technical accuracy
3. Writing clarity and style
4. Markup best practices (LaTeX or Typst)
5. Specific improvement suggestions`;

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
          baseURL: baseUrl,
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
          baseURL: effectiveBaseUrl,
        });
        return openai.chat(effectiveModel);
      }
    }
  }

  /** Update AI configuration */
  updateConfig(config: AIConfig): void {
    if (!config.apiKey) {
      console.warn('[AIService] API Key not configured');
      this.currentConfig = null;
      return;
    }

    this.currentConfig = config;
    logger.info(`[AIService] Config updated: ${config.provider} ${config.baseUrl} ${config.model}`);
  }

  /** Get current configuration */
  getConfig(): AIConfig | null {
    return this.currentConfig;
  }

  /** Check if AI is configured */
  isConfigured(): boolean {
    return this.currentConfig !== null && !!this.currentConfig.apiKey;
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

  /**
   * Polish text with AI, supports RAG context enhancement.
   */
  async polishText(text: string, ragContext?: string): Promise<string> {
    const model = this.createModel();

    logger.info('[AIService] Polishing text, RAG context:', ragContext ? 'yes' : 'no');
    if (ragContext) {
      logger.info(`[AIService] RAG context length: ${ragContext.length} chars`);
    }

    let systemPrompt = POLISH_SYSTEM_PROMPT;
    if (ragContext) {
      systemPrompt += `\n\nReference materials from knowledge base:\n${ragContext}\n\nUse the above reference materials to improve the text quality and ensure academic accuracy. If relevant, you may incorporate information from the references.`;
    }

    try {
      const { text: result } = await generateText({
        model,
        system: systemPrompt,
        prompt: `Please polish the following text:\n\n${text}`,
        maxOutputTokens: this.currentConfig?.maxTokens || 4096,
        temperature: 0.3,
      });

      logger.info(`[AIService] Polish complete, result length: ${result.length} chars`);
      return result;
    } catch (error) {
      console.error('[AIService] Polish failed:', error);
      throw error;
    }
  }

  /** AI chat (non-streaming) */
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

  /**
   * Generate mathematical formula (supports LaTeX and Typst).
   * @param format Output format, defaults to 'latex'
   */
  async generateFormula(description: string, format: 'latex' | 'typst' = 'latex'): Promise<string> {
    const model = this.createModel();

    const formatInstructions =
      format === 'typst'
        ? 'Return Typst math syntax. Use $...$ for math mode. Example: $frac(a, b)$, $sum_(i=1)^n$'
        : 'Return LaTeX math syntax. Use $...$ for inline, \\[...\\] for display. Example: $\\frac{a}{b}$, $\\sum_{i=1}^{n}$';

    const prompt = `Generate a mathematical formula based on the following description. Return only the ${format.toUpperCase()} code without any explanatory text.

Description: ${description}

${formatInstructions}

Requirements:
1. Return complete ${format.toUpperCase()} mathematical formula code
2. Use appropriate math syntax for ${format.toUpperCase()}
3. Ensure correct syntax that compiles properly`;

    try {
      const { text } = await generateText({
        model,
        system: FORMULA_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 500,
        temperature: 0.3,
      });

      return text.trim();
    } catch (error) {
      console.error('[AIService] Formula generation failed:', error);
      throw error;
    }
  }

  /** Review document with AI (supports LaTeX and Typst) */
  async reviewDocument(content: string): Promise<string> {
    const model = this.createModel();

    const prompt = `Please review the following scientific document and provide detailed, constructive feedback:

${content}

Provide your review in the following format:
1. **Overall Assessment**: Brief summary of the document quality
2. **Structure & Organization**: Feedback on logical flow and structure
3. **Technical Content**: Accuracy and clarity of technical content
4. **Language & Style**: Grammar, clarity, and academic writing quality
5. **Markup Usage**: Correct usage of LaTeX/Typst syntax and best practices
6. **Specific Suggestions**: Line-by-line suggestions for improvement`;

    try {
      const { text } = await generateText({
        model,
        system: REVIEW_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: this.currentConfig?.maxTokens || 4096,
        temperature: 0.5,
      });

      return text;
    } catch (error) {
      console.error('[AIService] Review failed:', error);
      throw error;
    }
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
 * @remarks Returns a fresh instance for ServiceContainer registration.
 */
export function createAIService(): IAIService {
  return new AIService();
}

/**
 * @remarks Singleton instance for direct import (backward compatibility).
 */
export const aiService: IAIService = new AIService();
