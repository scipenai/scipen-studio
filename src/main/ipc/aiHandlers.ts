/**
 * @file AI service IPC handlers (Type-Safe)
 * @description Handles AI chat, polish, streaming, and model management via IPC.
 * @depends IAIService, IKnowledgeService (for RAG-enhanced polish)
 */

import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import type { AIConfig, AIMessage, IAIService, IKnowledgeService } from '../services/interfaces';
import { createTypedHandlers, registerTypedHandler } from './typedIpc';

const logger = createLogger('AIHandlers');

// ====== Types ======

/** AI handler dependencies (injected at registration) */
export interface AIHandlersDeps {
  /** AI service instance */
  aiService: IAIService;
  /** Knowledge service getter (lazy, may not be initialized at registration time) */
  getKnowledgeService: () => IKnowledgeService;
}

// ====== Handler Registration ======

/**
 * Register AI-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for AI operations
 */
export function registerAIHandlers(deps: AIHandlersDeps): void {
  const { aiService, getKnowledgeService } = deps;

  const handlers = createTypedHandlers(
    {
      [IpcChannel.AI_UpdateConfig]: (config) => {
        aiService.updateConfig(config as AIConfig);
        return { success: true };
      },

      [IpcChannel.AI_IsConfigured]: () => {
        return aiService.isConfigured();
      },

      [IpcChannel.AI_Completion]: async (context) => {
        try {
          const content = await aiService.getCompletion(context);
          return { success: true, content };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      // RAG-enhanced polish: optionally retrieves context from knowledge base
      [IpcChannel.AI_Polish]: async (text, knowledgeBaseId) => {
        try {
          let ragContext = '';
          const knowledgeService = getKnowledgeService();

          logger.info('[Polish] Starting polish operation');
          logger.info(`[Polish] Input length: ${text.length} chars`);

          if (knowledgeBaseId && knowledgeService) {
            logger.info(`[Polish] Knowledge base ID: ${knowledgeBaseId}`);
            const startTime = Date.now();

            try {
              const searchResult = await knowledgeService.search({
                query: text,
                libraryIds: [knowledgeBaseId],
                topK: 3,
                scoreThreshold: 0.3,
              });

              logger.info(`[Polish] RAG search took: ${Date.now() - startTime}ms`);
              logger.info(`[Polish] RAG results count: ${searchResult.length}`);

              if (searchResult.length > 0) {
                ragContext = searchResult
                  .map((r: { content?: string }) => r.content || '')
                  .join('\n\n---\n\n');
              }
            } catch (ragError) {
              console.error('[Polish] RAG search failed:', ragError);
            }
          }

          const content = await aiService.polishText(text, ragContext || undefined);
          logger.info('[Polish] Polish operation complete');

          return { success: true, content };
        } catch (error) {
          console.error('[Polish] Polish failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      [IpcChannel.AI_Chat]: async (messages) => {
        try {
          const content = await aiService.chat(messages as AIMessage[]);
          return { success: true, content };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      [IpcChannel.AI_GenerateFormula]: async (description) => {
        try {
          const content = await aiService.generateFormula(description);
          return { success: true, content };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      [IpcChannel.AI_Review]: async (documentContent) => {
        try {
          const content = await aiService.reviewDocument(documentContent);
          return { success: true, content };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      [IpcChannel.AI_TestConnection]: async () => {
        return aiService.testConnection();
      },

      [IpcChannel.AI_StopGeneration]: () => {
        const stopped = aiService.stopGeneration();
        return { success: stopped };
      },

      [IpcChannel.AI_IsGenerating]: () => {
        return aiService.isGenerating();
      },

      [IpcChannel.AI_FetchModels]: async (baseUrl: string, apiKey?: string) => {
        try {
          const url = `${baseUrl.replace(/\/$/, '')}/models`;
          logger.info(`[FetchModels] Fetching models from: ${url}`);

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
          }

          const response = await fetch(url, {
            method: 'GET',
            headers,
            // Extended to 60s: some APIs have long model lists, 15s not enough on slow networks
            signal: AbortSignal.timeout(60000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = (await response.json()) as {
            data?: Array<{ id: string; object?: string; owned_by?: string; created?: number }>;
            object?: string;
          };
          const models = data.data || [];

          logger.info(`[FetchModels] Retrieved ${models.length} models`);
          return { success: true, models };
        } catch (error) {
          logger.error('[FetchModels] Failed to fetch models:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();

  // Streaming chat: requires access to event.sender, registered separately
  registerTypedHandler(
    IpcChannel.AI_ChatStream,
    async (event, messages) => {
      logger.info(
        `[AI ChatStream] Received stream request, messages count: ${(messages as AIMessage[]).length}`
      );
      const webContents = event.sender;
      try {
        let chunkCount = 0;
        let hasError = false;

        for await (const chunk of aiService.chatStream(messages as AIMessage[])) {
          chunkCount++;
          webContents.send('ai:stream-chunk', chunk);

          if (chunkCount === 1) {
            logger.info(`[AI ChatStream] First chunk sent: ${chunk.type}`);
          }

          if (chunk.type === 'error') {
            hasError = true;
            logger.warn(`[AI ChatStream] Error chunk received: ${chunk.error}`);
          }
        }

        logger.info(
          `[AI ChatStream] Stream complete, sent ${chunkCount} chunks, hasError: ${hasError}`
        );
        return { success: !hasError };
      } catch (error) {
        // Ensure error chunk is sent to renderer if exception occurs outside for-await loop
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('[AI ChatStream] Stream error:', error);

        webContents.send('ai:stream-chunk', { type: 'error', error: errorMessage });

        return { success: false, error: errorMessage };
      }
    },
    { logErrors: true }
  );

  logger.info('[IPC] AI handlers registered');
}
