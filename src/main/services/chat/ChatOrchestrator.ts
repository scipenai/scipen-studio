/**
 * @file ChatOrchestrator - Chat session orchestration service
 * @description Coordinates AI service, RAG retrieval, and @ file references for chat sessions.
 * @depends IAIService, IFileSystemService, ChatSessionStore, AtMentionProcessor
 * @implements IChatOrchestrator, IDisposable
 */

import type { WebContents } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import type {
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  Citation,
  SendMessageOptions,
} from '../../../../shared/types/chat';
import { createLogger } from '../LoggerService';
import type { AIMessage, IAIService } from '../interfaces/IAIService';
import type { IChatOrchestrator } from '../interfaces/IChatOrchestrator';
import type { IFileSystemService } from '../interfaces/IFileSystemService';
import { getKnowledgeService } from '../knowledge/MultimodalKnowledgeService';
import { AtMentionProcessor } from './AtMentionProcessor';
import { ChatSessionStore, type InternalChatSession } from './ChatSessionStore';

const logger = createLogger('ChatOrchestrator');

// ====== System Prompt ======

const ASK_SYSTEM_PROMPT = `You are SciPen AI, a professional scientific writing assistant specializing in LaTeX, Typst, and academic writing.

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

// ====== Implementation ======

export class ChatOrchestrator implements IChatOrchestrator {
  private readonly sessionStore: ChatSessionStore;
  private readonly atMentionProcessor: AtMentionProcessor;

  constructor(
    private readonly aiService: IAIService,
    fileService: IFileSystemService
  ) {
    this.sessionStore = new ChatSessionStore();
    this.atMentionProcessor = new AtMentionProcessor(fileService, {
      maxFiles: 10,
      maxFileChars: 50000,
      maxTotalChars: 100000,
      respectGitIgnore: true,
    });

    logger.info('[ChatOrchestrator] Initialized');
  }

  // ====== Message Sending ======

  async sendMessage(
    sessionId: string | null,
    content: string,
    options: SendMessageOptions,
    webContents: WebContents
  ): Promise<{ sessionId: string; userMessageId: string }> {
    // Get or create session
    let session: InternalChatSession;
    if (sessionId) {
      const existing = this.sessionStore.getSession(sessionId);
      if (!existing) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      session = existing;

      // Cancel any ongoing generation in this session before starting a new one
      if (session.status === 'running') {
        this.sessionStore.abortSession(session.id);
        logger.info(`[ChatOrchestrator] Cancelled session ${session.id} to start new request`);
      }
    } else {
      session = this.sessionStore.createSession(options.knowledgeBaseId);
    }

    // Add user message
    const userMessage = this.sessionStore.addMessage(session.id, {
      role: 'user',
      content,
    });

    // Emit session created event for new sessions
    if (!sessionId) {
      this.emit(webContents, { type: 'session_created', sessionId: session.id });
    }

    // Set abort controller (creates new one, replacing any aborted controller)
    const abortController = new AbortController();
    this.sessionStore.setAbortController(session.id, abortController);
    this.sessionStore.updateSessionStatus(session.id, 'running');

    // Run Ask mode (simple RAG chat with @file references)
    this.runAskMode(session, content, options, webContents, abortController.signal).catch((err) => {
      logger.error('[ChatOrchestrator] Ask mode error:', err);
      this.emit(webContents, {
        type: 'error',
        error: { code: 'ASK_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
      this.sessionStore.updateSessionStatus(session.id, 'error');
    });

    return { sessionId: session.id, userMessageId: userMessage.id };
  }

  // ====== Ask Mode (RAG Chat with @file references) ======

  private async runAskMode(
    session: InternalChatSession,
    content: string,
    options: SendMessageOptions,
    webContents: WebContents,
    signal: AbortSignal
  ): Promise<void> {
    // 1. Process @ mentions in user content (with error handling)
    let cleanedContent = content;
    let fileContext = '';

    try {
      const atResult = await this.atMentionProcessor.process(content);
      cleanedContent = atResult.cleanedText;
      fileContext = atResult.formattedContext;

      if (atResult.files.length > 0 || atResult.failed.length > 0) {
        logger.info(
          `[ChatOrchestrator] @ reference resolved: ${atResult.files.length} files, ${atResult.failed.length} failed`
        );
        this.emit(webContents, {
          type: 'files_referenced',
          files: atResult.files.map((f) => ({
            path: f.relativePath,
            truncated: f.truncated,
            tokenEstimate: f.tokenEstimate,
          })),
          failed: atResult.failed,
        });
      }
    } catch (err) {
      logger.warn('[ChatOrchestrator] @ reference processing failed:', err);
      // Continue with original content if @ processing fails
    }

    // 2. Build RAG context if knowledge base is selected
    let ragContext = '';
    let citations: Citation[] = [];
    let searchTime: number | undefined;

    if (options.knowledgeBaseId) {
      this.emit(webContents, { type: 'rag_search_start' });
      const searchStartTime = Date.now();

      try {
        const knowledgeService = getKnowledgeService();
        if (knowledgeService) {
          const results = await knowledgeService.search({
            query: cleanedContent,
            libraryIds: [options.knowledgeBaseId],
            topK: 5,
            scoreThreshold: 0.5,
          });

          searchTime = Date.now() - searchStartTime;

          if (results.length > 0) {
            ragContext = results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n\n');

            citations = results.map((r) => ({
              documentId: r.documentId,
              documentName: r.filename || 'Unknown',
              snippet: r.content.slice(0, 200),
              score: r.score,
              // PDF
              page: r.chunkMetadata?.page,
              section: r.chunkMetadata?.section,
              // Audio metadata
              startTime: r.chunkMetadata?.startTime,
              endTime: r.chunkMetadata?.endTime,
              speaker: r.chunkMetadata?.speaker,
              // Image metadata
              caption: r.chunkMetadata?.caption,
            }));
          }
        }
      } catch (err) {
        searchTime = Date.now() - searchStartTime;
        logger.warn('[ChatOrchestrator] RAG retrieval failed:', err);
      }

      this.emit(webContents, { type: 'rag_search_complete', citations, searchTime });
    }

    // 3. Build system prompt with all contexts
    let systemPrompt = ASK_SYSTEM_PROMPT;

    // Add @ mentioned file contents
    if (fileContext) {
      systemPrompt += `\n\n${fileContext}`;
    }

    // Add RAG context with detailed citation guidelines
    if (ragContext) {
      systemPrompt += `\n\n## Reference Materials from Knowledge Base
${ragContext}

## Response Requirements
1. Prioritize using information from the reference materials to answer questions
2. When citing reference materials, mark the citation after the relevant content, e.g., [1], [2]
3. If reference materials are insufficient to fully answer the question, supplement with your knowledge but indicate this
4. Keep responses accurate, professional, and concise
5. Use Markdown format, including LaTeX for mathematical formulas`;
    }

    // Get message history (filter out tool/system messages, and override latest user content)
    const historyMessages = this.buildHistoryMessages(session.id, cleanedContent);
    const aiMessages: AIMessage[] = [{ role: 'system', content: systemPrompt }, ...historyMessages];

    // Create assistant message placeholder
    const assistantMessage = this.sessionStore.addMessage(session.id, {
      role: 'assistant',
      content: '',
      citations: citations.length > 0 ? citations : undefined,
      searchTime,
    });

    this.emit(webContents, {
      type: 'message_start',
      messageId: assistantMessage.id,
      role: 'assistant',
    });

    // Stream response
    let fullResponse = '';
    try {
      const stream = this.aiService.chatStream(aiMessages);

      for await (const chunk of stream) {
        if (signal.aborted) {
          this.emit(webContents, { type: 'cancelled' });
          return;
        }

        if (chunk.type === 'chunk' && chunk.content) {
          fullResponse += chunk.content;
          this.emit(webContents, { type: 'text_delta', content: chunk.content });
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error ?? 'Stream error');
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this.emit(webContents, { type: 'cancelled' });
        return;
      }
      throw err;
    }

    // Update message with full content
    this.sessionStore.updateMessage(session.id, assistantMessage.id, {
      content: fullResponse,
    });

    this.emit(webContents, { type: 'message_complete', messageId: assistantMessage.id });
    this.emit(webContents, { type: 'done' });

    this.sessionStore.updateSessionStatus(session.id, 'idle');
    this.sessionStore.clearAbortController(session.id);
  }

  // ====== Control Methods ======

  cancelGeneration(sessionId: string): void {
    const aborted = this.sessionStore.abortSession(sessionId);
    if (aborted) {
      this.sessionStore.updateSessionStatus(sessionId, 'idle');
      logger.info(`[ChatOrchestrator] Session cancelled: ${sessionId}`);
    }
  }

  // ====== Session Management ======

  createSession(knowledgeBaseId?: string): ChatSession {
    const session = this.sessionStore.createSession(knowledgeBaseId);
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      knowledgeBaseId: session.knowledgeBaseId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
    };
  }

  getSessions(): ChatSession[] {
    return this.sessionStore.getSessions();
  }

  getSession(sessionId: string): ChatSession | undefined {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      knowledgeBaseId: session.knowledgeBaseId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
    };
  }

  getMessages(
    sessionId: string,
    limit?: number,
    before?: number
  ): { messages: ChatMessage[]; hasMore: boolean } {
    return this.sessionStore.getMessages(sessionId, limit, before);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessionStore.deleteSession(sessionId);
  }

  renameSession(sessionId: string, title: string): boolean {
    return this.sessionStore.renameSession(sessionId, title);
  }

  isGenerating(sessionId: string): boolean {
    const session = this.sessionStore.getSession(sessionId);
    return session?.status === 'running';
  }

  // ====== Helpers ======

  private emit(webContents: WebContents, event: ChatStreamEvent): void {
    if (!webContents.isDestroyed()) {
      webContents.send(IpcChannel.Chat_Stream, event);
    }
  }

  private buildHistoryMessages(sessionId: string, overrideUserContent?: string): AIMessage[] {
    type HistoryItem = {
      role: 'user' | 'assistant';
      content: string;
    };

    const { messages } = this.sessionStore.getMessages(sessionId);
    const history: HistoryItem[] = [];

    for (const message of messages) {
      if (message.role === 'user' || message.role === 'assistant') {
        if (message.content) {
          history.push({
            role: message.role,
            content: message.content,
          });
        }
      }
      // Tool messages are ignored in Ask-only mode
    }

    if (overrideUserContent !== undefined) {
      let replaced = false;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          history[i] = { role: 'user', content: overrideUserContent };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        history.push({ role: 'user', content: overrideUserContent });
      }
    }

    return history.map(({ role, content }) => ({ role, content }));
  }

  // ====== IDisposable ======

  dispose(): void {
    this.sessionStore.dispose();
    logger.info('[ChatOrchestrator] Disposed');
  }
}
