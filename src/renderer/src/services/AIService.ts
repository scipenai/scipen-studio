/**
 * @file AIService.ts - AI Service Proxy
 * @description Renderer process AI service proxy that calls main process via IPC to avoid exposing API Key
 * @depends IPC (api.ai)
 */

import { api } from '../api';
import type { AIConfig, AIMessageSimple, StreamCallbacks } from '../types';

type AIMessage = AIMessageSimple;

// Re-export types for backward compatibility
export type { AIMessageSimple as AIMessage, AIConfig, StreamCallbacks };

class AIServiceClass {
  // NOTE: Configuration sync has been moved to useAIConfigSync hook
  // This service is now a pure IPC proxy and no longer maintains internal configuration state

  /**
   * AI text completion
   * Uses completionModel (low latency/cost model, e.g., gpt-4o-mini)
   */
  async getCompletion(context: string): Promise<string> {
    const result = await api.ai.completion(context);
    if (!result?.success) {
      throw new Error(result?.error || 'AI completion failed');
    }

    return result.content || '';
  }

  /**
   * AI text polishing (supports RAG enhancement)
   * Uses polishModel (high-quality model, e.g., gpt-4o)
   * @param text Text to polish
   * @param knowledgeBaseId Optional knowledge base ID for RAG enhancement
   */
  async polishText(text: string, knowledgeBaseId?: string): Promise<string> {
    const result = await api.ai.polish(text, knowledgeBaseId);
    if (!result?.success) {
      throw new Error(result?.error || 'AI polishing failed');
    }

    return result.content || '';
  }

  /**
   * AI chat
   */
  async chat(messages: AIMessage[]): Promise<string> {
    const result = await api.ai.chat(messages);
    if (!result?.success) {
      throw new Error(result?.error || 'AI chat failed');
    }

    return result.content || '';
  }

  /**
   * AI chat with streaming output
   * @param messages Message history
   * @param callbacks Callback functions
   * @param signal Optional AbortSignal to cancel the request (e.g., when component unmounts)
   */
  async chatStream(
    messages: AIMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    // Return early if signal is already aborted to avoid unnecessary work
    if (signal?.aborted) {
      return;
    }

    const cleanup = api.ai.onStreamChunk((chunk) => {
      // Ignore subsequent chunks if already aborted to prevent processing stale data
      if (signal?.aborted) {
        return;
      }

      if (chunk.type === 'chunk' && chunk.content) {
        callbacks.onChunk(chunk.content);
      } else if (chunk.type === 'complete' && chunk.content) {
        callbacks.onComplete(chunk.content);
      } else if (chunk.type === 'error') {
        callbacks.onError(new Error(chunk.error || 'Streaming response error'));
      }
    });

    const abortHandler = () => {
      // Notify main process to stop generation to prevent wasted resources
      api.ai.stopGeneration().catch(console.error);
      // Clean up immediately to prevent memory leaks
      cleanup?.();
    };

    signal?.addEventListener('abort', abortHandler);

    // Set timeout to prevent UI from waiting indefinitely
    const timeoutId = setTimeout(() => {
      if (!signal?.aborted) {
        callbacks.onError(
          new Error('AI response timeout, please check network connection or try again later')
        );
        cleanup?.();
      }
    }, 120000);

    try {
      const result = await api.ai.chatStream(messages);

      clearTimeout(timeoutId);

      // Skip processing result if already aborted to avoid race conditions
      if (signal?.aborted) {
        return;
      }

      if (!result?.success) {
        callbacks.onError(new Error(result?.error || 'AI streaming chat failed'));
      }
    } catch (error) {
      clearTimeout(timeoutId);

      // Silently handle cancellation errors to avoid unnecessary error callbacks
      if (signal?.aborted) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      callbacks.onError(new Error(errorMessage || 'AI streaming chat exception'));
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      cleanup?.();
    }
  }

  /**
   * Generate LaTeX formula
   */
  async generateFormula(description: string): Promise<string> {
    const result = await api.ai.generateFormula(description);
    if (!result?.success) {
      throw new Error(result?.error || 'Formula generation failed');
    }

    return result.content || '';
  }

  /**
   * AI document review
   */
  async reviewDocument(content: string): Promise<string> {
    const result = await api.ai.review(content);
    if (!result?.success) {
      throw new Error(result?.error || 'AI review failed');
    }

    return result.content || '';
  }

  /**
   * Test AI connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const result = await api.ai.testConnection();
    return result || { success: false, message: 'Unable to connect to main process' };
  }
}

export const AIService = new AIServiceClass();
