/**
 * @file ChatOrchestrator - Chat session orchestration service
 * @description Coordinates AI service and @ file references for chat sessions.
 * @depends IAIService, IFileSystemService, ChatSessionStore, AtMentionProcessor
 * @implements IChatOrchestrator, IDisposable
 */

import path from 'node:path';
import type { WebContents } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import type {
  ChatMessageBlock,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  SendMessageOptions,
  ThinkingStep,
} from '../../../../shared/types/chat';
import { createLogger } from '../LoggerService';
import type { AIMessage, IAIService } from '../interfaces/IAIService';
import type { IChatOrchestrator } from '../interfaces/IChatOrchestrator';
import type { IFileSystemService } from '../interfaces/IFileSystemService';
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

const FILE_WRITE_SYSTEM_PROMPT = `You are SciPen Research Assistant.

The user wants you to produce the full contents of a single research document file.

Rules:
1. Return ONLY the complete file content.
2. Do NOT wrap the answer in code fences.
3. Do NOT explain what you changed.
4. Make the file immediately usable and reasonably complete.
5. Respect the target format inferred from the file extension.
6. If the target is Typst, return valid Typst source.
7. If the target is LaTeX, return valid LaTeX source.
8. If existing file content is provided, revise it instead of ignoring it.`;

const DEFAULT_SESSION_TITLE = 'New Conversation';

type FileWriteTask = {
  absolutePath: string;
  displayPath: string;
  fileName: string;
  language: string;
};

// ====== Implementation ======

export class ChatOrchestrator implements IChatOrchestrator {
  private readonly sessionStore: ChatSessionStore;
  private readonly atMentionProcessor: AtMentionProcessor;
  private readonly fileService: IFileSystemService;

  constructor(
    private readonly aiService: IAIService,
    fileService: IFileSystemService
  ) {
    this.fileService = fileService;
    this.sessionStore = new ChatSessionStore();
    this.atMentionProcessor = new AtMentionProcessor(fileService, {
      maxFiles: 10,
      maxFileChars: 50000,
      maxTotalChars: 100000,
      respectGitIgnore: false, // not implemented; keep explicitly off
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
      session = this.sessionStore.createSession();
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

    // Run Ask mode (chat with @file references)
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

  // ====== Ask Mode (Chat with @file references) ======

  private async runAskMode(
    session: InternalChatSession,
    content: string,
    options: SendMessageOptions,
    webContents: WebContents,
    signal: AbortSignal
  ): Promise<void> {
    const fileTask = this.detectFileWriteTask(content, options);
    if (fileTask) {
      await this.runFileWriteMode(session, content, fileTask, webContents, signal);
      return;
    }

    const send = this.emitFor(webContents, session.id);

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
        send({
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

    // 2. Build system prompt with file contexts
    let systemPrompt = ASK_SYSTEM_PROMPT;

    // Add @ mentioned file contents
    if (fileContext) {
      systemPrompt += `\n\n${fileContext}`;
    }

    // Get message history (filter out tool/system messages, and override latest user content)
    const historyMessages = this.buildHistoryMessages(session.id, cleanedContent);
    const aiMessages: AIMessage[] = [{ role: 'system', content: systemPrompt }, ...historyMessages];

    // Create assistant message placeholder
    const assistantMessage = this.sessionStore.addMessage(session.id, {
      role: 'assistant',
      content: '',
    });

    send({
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
          send({ type: 'cancelled' });
          return;
        }

        if (chunk.type === 'chunk' && chunk.content) {
          fullResponse += chunk.content;
          send({ type: 'text_delta', content: chunk.content });
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error ?? 'Stream error');
        }
      }
    } catch (err) {
      if (signal.aborted) {
        send({ type: 'cancelled' });
        return;
      }
      throw err;
    }

    this.sessionStore.updateMessage(session.id, assistantMessage.id, {
      content: fullResponse,
      blocks: [
        {
          type: 'markdown',
          content: fullResponse,
        } satisfies ChatMessageBlock,
      ],
    });

    send({ type: 'message_complete', messageId: assistantMessage.id });
    send({ type: 'done' });

    this.sessionStore.updateSessionStatus(session.id, 'idle');
    this.sessionStore.clearAbortController(session.id);
    const heuristicTitle = this.sessionStore.peekGeneratedTitle(content);
    this.emitSessionTitleIfUpdated(session.id, heuristicTitle, webContents);
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

  createSession(): ChatSession {
    const session = this.sessionStore.createSession();
    return {
      id: session.id,
      title: session.title,
      status: session.status,
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

  /** Creates an emitter bound to a sessionId; injects sessionId into events that allow it. */
  private emitFor(webContents: WebContents, sessionId: string) {
    return (event: ChatStreamEvent) => {
      // Only inject for event types that declare a sessionId field
      const enriched = 'sessionId' in event ? event : ({ ...event, sessionId } as ChatStreamEvent);
      this.emit(webContents, enriched);
    };
  }

  private emitSessionTitleIfUpdated(
    sessionId: string,
    nextTitle: string,
    webContents: WebContents
  ): void {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) return;

    if (session.title !== nextTitle && session.title !== DEFAULT_SESSION_TITLE) {
      return;
    }

    if (!this.sessionStore.renameSession(sessionId, nextTitle)) {
      return;
    }

    const updated = this.sessionStore.getSession(sessionId);
    if (!updated) return;

    this.emit(webContents, {
      type: 'session_updated',
      session: {
        id: updated.id,
        title: updated.title,
        status: updated.status,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        messageCount: updated.messageCount,
      },
    });
  }

  private detectFileWriteTask(content: string, options: SendMessageOptions): FileWriteTask | null {
    const patterns = [
      /(?:在|把|向)\s*([\w./\\-]+\.(?:typ|tex|md|txt))\s*(?:里|中)?(?:写|创建|生成|起草|撰写|编辑|修改)/i,
      /(?:write|create|draft|generate|edit|update)\b[\s\S]{0,80}?\b(?:in|to)\s+([\w./\\-]+\.(?:typ|tex|md|txt))/i,
    ];

    const matched = patterns
      .map((pattern) => content.match(pattern)?.[1])
      .find((value): value is string => Boolean(value));

    if (!matched) return null;

    const projectPath = options.workspace?.projectPath ?? undefined;
    const activeFilePath = options.workspace?.activeFilePath ?? undefined;
    const baseDir = projectPath || (activeFilePath ? path.dirname(activeFilePath) : undefined);

    if (!baseDir && !path.isAbsolute(matched)) {
      return null;
    }

    const absolutePath = path.isAbsolute(matched)
      ? path.normalize(matched)
      : path.normalize(path.join(baseDir || '', matched));
    const fileName = path.basename(absolutePath);
    const language = this.detectArtifactLanguage(fileName);

    return {
      absolutePath,
      displayPath: projectPath ? path.relative(projectPath, absolutePath) || fileName : fileName,
      fileName,
      language,
    };
  }

  private async runFileWriteMode(
    session: InternalChatSession,
    content: string,
    task: FileWriteTask,
    webContents: WebContents,
    signal: AbortSignal
  ): Promise<void> {
    const send = this.emitFor(webContents, session.id);

    const assistantMessage = this.sessionStore.addMessage(session.id, {
      role: 'assistant',
      content: '',
      blocks: [],
    });

    send({
      type: 'message_start',
      messageId: assistantMessage.id,
      role: 'assistant',
    });

    const steps: ThinkingStep[] = [
      { id: 'plan', label: '规划文档结构', status: 'completed' },
      { id: 'write', label: `写入 ${task.fileName}`, status: 'running' },
      { id: 'deliver', label: '整理可直接打开的制品', status: 'pending' },
    ];

    send({
      type: 'agent_state',
      status: 'running',
      tool: 'writer',
      message: `正在写入 ${task.fileName}…`,
    });
    send({
      type: 'thinking_update',
      title: 'OpenClaw 正在处理',
      steps,
      collapsed: false,
    });

    let existingContent = '';
    try {
      const existing = await this.fileService.readFile(task.absolutePath);
      existingContent = existing.content;
    } catch {
      existingContent = '';
    }

    const aiMessages: AIMessage[] = [
      {
        role: 'system',
        content: `${FILE_WRITE_SYSTEM_PROMPT}\n\nTarget file: ${task.fileName}\nTarget language: ${task.language}`,
      },
      {
        role: 'user',
        content: `${content}\n\n${existingContent ? `Existing file content:\n\n${existingContent}` : 'No existing file content. Create it from scratch.'}`,
      },
    ];

    const generated = await this.aiService.chat(aiMessages);
    if (signal.aborted) {
      send({ type: 'cancelled' });
      return;
    }

    const sanitizedContent = this.stripCodeFences(generated).trim();
    await this.fileService.writeFile(task.absolutePath, sanitizedContent, { ensureDir: true });

    const completedSteps: ThinkingStep[] = [
      { id: 'plan', label: '规划文档结构', status: 'completed' },
      { id: 'write', label: `写入 ${task.fileName}`, status: 'completed' },
      { id: 'deliver', label: '整理可直接打开的制品', status: 'completed' },
    ];

    const summary = `我已经把内容写入 \`${task.displayPath}\`，你可以直接打开编辑器或快速编译。`;
    const artifact = {
      id: `${session.id}:${task.absolutePath}`,
      path: task.absolutePath,
      title: task.fileName,
      kind: 'file' as const,
      language: task.language,
      summary: this.buildArtifactSummary(sanitizedContent),
      charCount: sanitizedContent.length,
      source: 'builtin' as const,
    };
    const blocks: ChatMessageBlock[] = [
      {
        type: 'thinking',
        title: 'OpenClaw 正在处理',
        steps: completedSteps,
        collapsed: true,
      },
      {
        type: 'artifact',
        artifact,
      },
      {
        type: 'markdown',
        content: summary,
      },
    ];

    this.sessionStore.updateMessage(session.id, assistantMessage.id, {
      content: summary,
      blocks,
    });

    send({
      type: 'thinking_update',
      title: 'OpenClaw 正在处理',
      steps: completedSteps,
      collapsed: true,
    });
    send({ type: 'artifact_upsert', artifact });
    send({ type: 'text_delta', content: summary });
    send({
      type: 'agent_state',
      status: 'idle',
      tool: 'writer',
      message: `${task.fileName} 已生成`,
    });
    send({ type: 'message_complete', messageId: assistantMessage.id });
    send({ type: 'done' });

    this.sessionStore.updateSessionStatus(session.id, 'idle');
    this.sessionStore.clearAbortController(session.id);
    const heuristicTitle = this.sessionStore.peekGeneratedTitle(content);
    this.emitSessionTitleIfUpdated(session.id, heuristicTitle, webContents);
  }

  private detectArtifactLanguage(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.typ')) return 'Typst';
    if (lower.endsWith('.tex') || lower.endsWith('.ltx')) return 'LaTeX';
    if (lower.endsWith('.md')) return 'Markdown';
    return 'Text';
  }

  private stripCodeFences(content: string): string {
    const trimmed = content.trim();
    const match = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
    return match ? match[1] : trimmed;
  }

  private buildArtifactSummary(content: string): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (!compact) return '新生成的研究文档';
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
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
