/**
 * @file ChatService.ts - Chat Service
 * @description Event-driven chat session and message management
 * @depends IPC (api.chat), shared/utils (Emitter)
 */

import type {
  ArtifactSummary,
  ChatMessageBlock,
  ChatSession,
  ChatStreamEvent,
  ReferencedFile,
  ReferencedFileFailed,
  SendMessageOptions,
  ChatMessage as UnifiedChatMessage,
} from '../../../../../shared/types/chat';
import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import { api } from '../../api';

// ============ Types ============

export interface SessionChangeEvent {
  readonly session: ChatSession;
  readonly type: 'created' | 'deleted' | 'renamed' | 'switched' | 'updated';
}

export interface MessageChangeEvent {
  readonly sessionId: string;
  readonly message: UnifiedChatMessage;
  readonly type: 'added' | 'updated' | 'completed';
}

export interface FilesReferencedEvent {
  readonly sessionId: string;
  readonly files: ReferencedFile[];
  readonly failed: ReferencedFileFailed[];
}

// ============ ChatService ============

export class ChatService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  // State
  private _sessionsById: Map<string, ChatSession> = new Map();
  private _sessionOrder: string[] = [];
  private _messagesById: Map<string, Map<string, UnifiedChatMessage>> = new Map(); // sessionId -> (msgId -> msg)
  private _messageOrderBySession: Map<string, string[]> = new Map();
  private _currentSessionId: string | null = null;
  private _isGenerating = false;

  // Cached values for useSyncExternalStore
  private _cachedSessions: ChatSession[] = [];
  private _cachedCurrentSession: ChatSession | null = null;
  private _cachedCurrentMessages: UnifiedChatMessage[] = [];
  private _cachedReferencedFiles: ReferencedFile[] = [];
  private _cachedReferencedFailed: ReferencedFileFailed[] = [];

  // Event stream cleanup
  private _streamUnsubscribe: (() => void) | null = null;

  // ============ Events ============

  private readonly _onDidCreateSession = new Emitter<SessionChangeEvent>();
  readonly onDidCreateSession: Event<SessionChangeEvent> = this._onDidCreateSession.event;

  private readonly _onDidDeleteSession = new Emitter<SessionChangeEvent>();
  readonly onDidDeleteSession: Event<SessionChangeEvent> = this._onDidDeleteSession.event;

  private readonly _onDidSwitchSession = new Emitter<string | null>();
  readonly onDidSwitchSession: Event<string | null> = this._onDidSwitchSession.event;

  private readonly _onDidRenameSession = new Emitter<SessionChangeEvent>();
  readonly onDidRenameSession: Event<SessionChangeEvent> = this._onDidRenameSession.event;

  private readonly _onDidUpdateSession = new Emitter<SessionChangeEvent>();
  readonly onDidUpdateSession: Event<SessionChangeEvent> = this._onDidUpdateSession.event;

  private readonly _onDidAddMessage = new Emitter<MessageChangeEvent>();
  readonly onDidAddMessage: Event<MessageChangeEvent> = this._onDidAddMessage.event;

  private readonly _onDidUpdateMessage = new Emitter<MessageChangeEvent>();
  readonly onDidUpdateMessage: Event<MessageChangeEvent> = this._onDidUpdateMessage.event;

  private readonly _onDidCompleteMessage = new Emitter<MessageChangeEvent>();
  readonly onDidCompleteMessage: Event<MessageChangeEvent> = this._onDidCompleteMessage.event;

  private readonly _onDidChangeLoading = new Emitter<boolean>();
  readonly onDidChangeLoading: Event<boolean> = this._onDidChangeLoading.event;

  private readonly _onDidStreamTextDelta = new Emitter<{ sessionId: string; content: string }>();
  readonly onDidStreamTextDelta: Event<{ sessionId: string; content: string }> =
    this._onDidStreamTextDelta.event;

  private readonly _onDidError = new Emitter<{ code: string; message: string }>();
  readonly onDidError: Event<{ code: string; message: string }> = this._onDidError.event;

  private readonly _onDidFilesReferenced = new Emitter<FilesReferencedEvent>();
  readonly onDidFilesReferenced: Event<FilesReferencedEvent> = this._onDidFilesReferenced.event;

  constructor() {
    // Register events
    this._disposables.add(this._onDidCreateSession);
    this._disposables.add(this._onDidDeleteSession);
    this._disposables.add(this._onDidSwitchSession);
    this._disposables.add(this._onDidRenameSession);
    this._disposables.add(this._onDidUpdateSession);
    this._disposables.add(this._onDidAddMessage);
    this._disposables.add(this._onDidUpdateMessage);
    this._disposables.add(this._onDidCompleteMessage);
    this._disposables.add(this._onDidChangeLoading);
    this._disposables.add(this._onDidStreamTextDelta);
    this._disposables.add(this._onDidError);
    this._disposables.add(this._onDidFilesReferenced);

    // Subscribe to stream events
    this._subscribeToStream();

    // Initial load
    void this._loadSessions();
  }

  // ============ Getters ============

  get sessions(): ChatSession[] {
    return this._cachedSessions;
  }

  get currentSessionId(): string | null {
    return this._currentSessionId;
  }

  get currentSession(): ChatSession | null {
    return this._cachedCurrentSession;
  }

  get isGenerating(): boolean {
    return this._isGenerating;
  }

  get referencedFiles(): ReferencedFile[] {
    return this._cachedReferencedFiles;
  }

  get referencedFailed(): ReferencedFileFailed[] {
    return this._cachedReferencedFailed;
  }

  getCurrentMessages(): UnifiedChatMessage[] {
    return this._cachedCurrentMessages;
  }

  getMessages(sessionId: string): UnifiedChatMessage[] {
    const msgMap = this._messagesById.get(sessionId);
    const order = this._messageOrderBySession.get(sessionId) ?? [];
    return order
      .map((id) => (msgMap ? msgMap.get(id) : undefined))
      .filter((msg): msg is UnifiedChatMessage => msg !== undefined);
  }

  // ============ Cache Updates ============

  private _updateSessionsCache(): void {
    this._cachedSessions = this._sessionOrder
      .map((id) => this._sessionsById.get(id)!)
      .filter(Boolean);
  }

  private _updateCurrentSessionCache(): void {
    this._cachedCurrentSession = this._currentSessionId
      ? (this._sessionsById.get(this._currentSessionId) ?? null)
      : null;
  }

  private _updateCurrentMessagesCache(): void {
    if (!this._currentSessionId) {
      this._cachedCurrentMessages = [];
      return;
    }
    const msgMap = this._messagesById.get(this._currentSessionId);
    const order = this._messageOrderBySession.get(this._currentSessionId) ?? [];
    this._cachedCurrentMessages = order
      .map((id) => (msgMap ? msgMap.get(id) : undefined))
      .filter((msg): msg is UnifiedChatMessage => msg !== undefined);
  }

  private async _loadSessions(): Promise<void> {
    try {
      const result = await api.chat.getSessions();
      const sessions = result.sessions ?? [];

      this._sessionsById.clear();
      this._sessionOrder = [];

      for (const session of sessions) {
        this._sessionsById.set(session.id, session);
        this._sessionOrder.push(session.id);
        if (!this._messagesById.has(session.id)) {
          this._messagesById.set(session.id, new Map());
        }
        if (!this._messageOrderBySession.has(session.id)) {
          this._messageOrderBySession.set(session.id, []);
        }
      }

      this._updateSessionsCache();

      if (!this._currentSessionId || !this._sessionsById.has(this._currentSessionId)) {
        this._currentSessionId = sessions[0]?.id ?? null;
      }

      this._updateCurrentSessionCache();

      if (this._currentSessionId) {
        await this._loadMessages(this._currentSessionId);
        this._onDidSwitchSession.fire(this._currentSessionId);
      }

      for (const session of sessions) {
        this._onDidUpdateSession.fire({ session, type: 'updated' });
      }
    } catch (error) {
      console.error('[ChatService] Failed to load sessions:', error);
    }
  }

  private async _loadMessages(sessionId: string): Promise<void> {
    try {
      const result = await api.chat.getMessages({ sessionId });
      const msgMap = new Map<string, UnifiedChatMessage>();
      const order: string[] = [];

      for (const msg of result.messages ?? []) {
        msgMap.set(msg.id, msg);
        order.push(msg.id);
      }

      this._messagesById.set(sessionId, msgMap);
      this._messageOrderBySession.set(sessionId, order);

      if (this._currentSessionId === sessionId) {
        this._updateCurrentMessagesCache();
        for (const msg of result.messages ?? []) {
          this._onDidAddMessage.fire({ sessionId, message: msg, type: 'added' });
        }
      }
    } catch (error) {
      console.error('[ChatService] Failed to load messages:', error);
    }
  }

  // ============ Stream Subscription ============

  private _subscribeToStream(): void {
    this._streamUnsubscribe = api.chat.onStream((event: ChatStreamEvent) => {
      this._handleStreamEvent(event);
    });
  }

  private _currentAssistantMessageId: string | null = null;

  private _handleStreamEvent(event: ChatStreamEvent): void {
    switch (event.type) {
      case 'session_created':
        // Session created on backend - sync if needed
        break;

      case 'session_updated': {
        const existing = this._sessionsById.get(event.session.id);
        this._sessionsById.set(event.session.id, event.session);
        if (!existing) {
          this._sessionOrder.unshift(event.session.id);
        }
        this._updateSessionsCache();
        if (this._currentSessionId === event.session.id) {
          this._updateCurrentSessionCache();
        }
        this._onDidUpdateSession.fire({ session: event.session, type: 'updated' });
        break;
      }

      case 'message_start': {
        // Create message placeholder
        const targetSession = event.sessionId ?? this._currentSessionId;
        if (targetSession && event.role === 'assistant') {
          const msg: UnifiedChatMessage = {
            id: event.messageId,
            sessionId: targetSession,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            blocks: [],
          };
          this._addMessageToCache(targetSession, msg);
          this._currentAssistantMessageId = event.messageId;
          this._onDidAddMessage.fire({
            sessionId: targetSession,
            message: msg,
            type: 'added',
          });
        }
        break;
      }

      case 'text_delta': {
        // Append to current assistant message
        const deltaSession = event.sessionId ?? this._currentSessionId;
        if (deltaSession && this._currentAssistantMessageId) {
          const msgMap = this._messagesById.get(deltaSession);
          const msg = msgMap?.get(this._currentAssistantMessageId);
          if (msg) {
            const blocks = this._upsertMarkdownBlock(msg.blocks, `${msg.content}${event.content}`);
            const updated: UnifiedChatMessage = {
              ...msg,
              content: `${msg.content}${event.content}`,
              blocks,
            };
            msgMap?.set(this._currentAssistantMessageId, updated);
            this._updateCurrentMessagesCache();
            this._onDidUpdateMessage.fire({
              sessionId: deltaSession,
              message: updated,
              type: 'updated',
            });
            this._onDidStreamTextDelta.fire({
              sessionId: deltaSession,
              content: event.content,
            });
          }
        }
        break;
      }

      case 'thinking_update': {
        const thinkSession = event.sessionId ?? this._currentSessionId;
        this._updateCurrentAssistantMessage(
          (msg) => ({
            ...msg,
            blocks: this._upsertThinkingBlock(
              msg.blocks,
              event.title,
              event.steps,
              event.collapsed
            ),
          }),
          thinkSession ?? undefined
        );
        break;
      }

      case 'artifact_upsert': {
        const artifactSession = event.sessionId ?? this._currentSessionId;
        this._updateCurrentAssistantMessage(
          (msg) => ({
            ...msg,
            blocks: this._upsertArtifactBlock(msg.blocks, event.artifact),
          }),
          artifactSession ?? undefined
        );
        break;
      }

      case 'compile_update': {
        const compileSession = event.sessionId ?? this._currentSessionId;
        this._updateCurrentAssistantMessage(
          (msg) => ({
            ...msg,
            blocks: this._upsertStatusBlock(
              msg.blocks,
              event.status,
              event.title,
              event.message,
              event.attempt,
              event.actionLabel
            ),
          }),
          compileSession ?? undefined
        );
        break;
      }

      case 'agent_state': {
        const agentSession = event.sessionId ?? this._currentSessionId;
        this._updateCurrentAssistantMessage(
          (msg) => ({
            ...msg,
            blocks: this._upsertStatusBlock(
              msg.blocks,
              event.status === 'error' ? 'error' : event.status === 'idle' ? 'success' : 'running',
              event.tool ? `Agent · ${event.tool}` : 'Agent',
              event.message
            ),
          }),
          agentSession ?? undefined
        );
        break;
      }

      case 'message_complete': {
        const completeSession = event.sessionId ?? this._currentSessionId;
        if (completeSession) {
          const msgMap = this._messagesById.get(completeSession);
          const msg = msgMap?.get(event.messageId);
          if (msg) {
            this._onDidCompleteMessage.fire({
              sessionId: completeSession,
              message: msg,
              type: 'completed',
            });
          }
        }
        this._currentAssistantMessageId = null;
        break;
      }

      case 'files_referenced': {
        const refSession = event.sessionId ?? this._currentSessionId;
        if (refSession) {
          this._cachedReferencedFiles = event.files;
          this._cachedReferencedFailed = event.failed;
          this._onDidFilesReferenced.fire({
            sessionId: refSession,
            files: event.files,
            failed: event.failed,
          });
        }
        break;
      }

      case 'done':
        this._resetTransientState({ clearReferences: false });
        this._setGenerating(false);
        break;

      case 'cancelled':
        this._resetTransientState({ clearReferences: false });
        this._setGenerating(false);
        break;

      case 'error':
        this._resetTransientState({ clearReferences: false });
        this._setGenerating(false);
        this._onDidError.fire(event.error);
        break;
    }
  }

  /**
   * Update the current assistant message. sessionIdOverride is used when streaming
   * events arrive for a non-current session.
   */
  private _updateCurrentAssistantMessage(
    updater: (message: UnifiedChatMessage) => UnifiedChatMessage,
    sessionIdOverride?: string
  ): void {
    const sessionId = sessionIdOverride ?? this._currentSessionId;
    if (!sessionId || !this._currentAssistantMessageId) return;

    const msgMap = this._messagesById.get(sessionId);
    const msg = msgMap?.get(this._currentAssistantMessageId);
    if (!msg) return;

    const updated = updater(msg);
    msgMap?.set(this._currentAssistantMessageId, updated);
    this._updateCurrentMessagesCache();
    this._onDidUpdateMessage.fire({
      sessionId,
      message: updated,
      type: 'updated',
    });
  }

  private _upsertMarkdownBlock(
    blocks: ChatMessageBlock[] | undefined,
    content: string
  ): ChatMessageBlock[] {
    const next = [...(blocks ?? [])];
    const index = next.findIndex((block) => block.type === 'markdown');
    const markdownBlock: ChatMessageBlock = { type: 'markdown', content };
    if (index === -1) {
      next.push(markdownBlock);
    } else {
      next[index] = markdownBlock;
    }
    return next;
  }

  private _upsertThinkingBlock(
    blocks: ChatMessageBlock[] | undefined,
    title: string,
    steps: import('../../../../../shared/types/chat').ThinkingStep[],
    collapsed?: boolean
  ): ChatMessageBlock[] {
    const next = [...(blocks ?? [])];
    const thinkingBlock: ChatMessageBlock = { type: 'thinking', title, steps, collapsed };
    const index = next.findIndex((block) => block.type === 'thinking');
    if (index === -1) {
      next.unshift(thinkingBlock);
    } else {
      next[index] = thinkingBlock;
    }
    return next;
  }

  private _upsertArtifactBlock(
    blocks: ChatMessageBlock[] | undefined,
    artifact: ArtifactSummary
  ): ChatMessageBlock[] {
    const next = [...(blocks ?? [])];
    const index = next.findIndex(
      (block) => block.type === 'artifact' && block.artifact.path === artifact.path
    );
    const artifactBlock: ChatMessageBlock = { type: 'artifact', artifact };
    if (index === -1) {
      next.push(artifactBlock);
    } else {
      next[index] = artifactBlock;
    }
    return next;
  }

  private _upsertStatusBlock(
    blocks: ChatMessageBlock[] | undefined,
    status: 'info' | 'running' | 'success' | 'warning' | 'error',
    title: string,
    message: string,
    attempt?: number,
    actionLabel?: string
  ): ChatMessageBlock[] {
    const next = [...(blocks ?? [])];
    const statusBlock: ChatMessageBlock = {
      type: 'status',
      status,
      title,
      message,
      attempt,
      actionLabel,
    };
    const index = next.findIndex((block) => block.type === 'status' && block.title === title);
    if (index === -1) {
      next.push(statusBlock);
    } else {
      next[index] = statusBlock;
    }
    return next;
  }

  /**
   * Reset transient state to prevent showing previous session's status when switching sessions
   */
  private _resetTransientState(options: { clearReferences?: boolean } = {}): void {
    const { clearReferences = true } = options;
    this._currentAssistantMessageId = null;
    if (clearReferences) {
      this._cachedReferencedFiles = [];
      this._cachedReferencedFailed = [];
    }
  }

  private _addMessageToCache(sessionId: string, msg: UnifiedChatMessage): void {
    let msgMap = this._messagesById.get(sessionId);
    if (!msgMap) {
      msgMap = new Map();
      this._messagesById.set(sessionId, msgMap);
    }
    msgMap.set(msg.id, msg);

    let order = this._messageOrderBySession.get(sessionId);
    if (!order) {
      order = [];
      this._messageOrderBySession.set(sessionId, order);
    }
    if (!order.includes(msg.id)) {
      order.push(msg.id);
    }

    this._updateCurrentMessagesCache();
  }

  // ============ Session Operations ============

  async createSession(): Promise<string> {
    const session = await api.chat.createSession();

    this._sessionsById.set(session.id, session);
    this._sessionOrder.unshift(session.id);
    this._messagesById.set(session.id, new Map());
    this._messageOrderBySession.set(session.id, []);
    this._currentSessionId = session.id;

    this._updateSessionsCache();
    this._updateCurrentSessionCache();
    this._updateCurrentMessagesCache();

    this._onDidCreateSession.fire({ session, type: 'created' });
    this._onDidSwitchSession.fire(session.id);

    return session.id;
  }

  switchSession(sessionId: string): void {
    if (!this._sessionsById.has(sessionId) || this._currentSessionId === sessionId) return;
    this._currentSessionId = sessionId;

    // Reset transient state to avoid showing previous session's status
    this._resetTransientState();

    this._updateCurrentSessionCache();
    this._updateCurrentMessagesCache();

    this._onDidSwitchSession.fire(sessionId);
    void this._loadMessages(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this._sessionsById.get(sessionId);
    if (!session) return;

    await api.chat.deleteSession(sessionId);

    this._sessionsById.delete(sessionId);
    this._messagesById.delete(sessionId);
    this._messageOrderBySession.delete(sessionId);
    this._sessionOrder = this._sessionOrder.filter((id) => id !== sessionId);

    this._updateSessionsCache();
    this._onDidDeleteSession.fire({ session, type: 'deleted' });

    if (this._currentSessionId === sessionId) {
      this._currentSessionId = this._sessionOrder[0] ?? null;
      this._updateCurrentSessionCache();
      this._updateCurrentMessagesCache();
      this._onDidSwitchSession.fire(this._currentSessionId);
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this._sessionsById.get(sessionId);
    if (!session) return;

    await api.chat.renameSession({ sessionId, title });

    session.title = title;
    session.updatedAt = Date.now();

    this._updateSessionsCache();
    if (sessionId === this._currentSessionId) {
      this._updateCurrentSessionCache();
    }

    this._onDidRenameSession.fire({ session, type: 'renamed' });
  }

  // ============ Message Operations ============

  addLocalMessage(
    message: Omit<UnifiedChatMessage, 'id' | 'sessionId' | 'timestamp'>
  ): UnifiedChatMessage | null {
    if (!this._currentSessionId) return null;

    const msg: UnifiedChatMessage = {
      ...message,
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: this._currentSessionId,
      timestamp: Date.now(),
    };

    this._addMessageToCache(this._currentSessionId, msg);
    this._onDidAddMessage.fire({
      sessionId: this._currentSessionId,
      message: msg,
      type: 'added',
    });

    return msg;
  }

  updateLocalMessage(
    messageId: string,
    updates: Partial<UnifiedChatMessage>
  ): UnifiedChatMessage | null {
    if (!this._currentSessionId) return null;

    const msgMap = this._messagesById.get(this._currentSessionId);
    const msg = msgMap?.get(messageId);
    if (!msg) return null;

    const updated: UnifiedChatMessage = {
      ...msg,
      ...updates,
      id: msg.id,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
    };

    msgMap?.set(messageId, updated);
    this._updateCurrentMessagesCache();
    this._onDidUpdateMessage.fire({
      sessionId: this._currentSessionId,
      message: updated,
      type: 'updated',
    });

    return updated;
  }

  async sendMessage(content: string, options: SendMessageOptions): Promise<void> {
    // Ensure we have a session
    if (!this._currentSessionId) {
      await this.createSession();
    }

    // Cancel any ongoing generation before starting a new one
    // This prevents state conflicts when switching sessions
    if (this._isGenerating) {
      try {
        await api.chat.cancel(this._currentSessionId!);
      } catch {
        // Ignore cancel errors
      }
    }

    // Reset transient state before starting new generation
    this._resetTransientState();
    this._setGenerating(true);

    // Add user message locally
    const userMsg: UnifiedChatMessage = {
      id: `user_${Date.now()}`,
      sessionId: this._currentSessionId!,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    this._addMessageToCache(this._currentSessionId!, userMsg);
    this._onDidAddMessage.fire({
      sessionId: this._currentSessionId!,
      message: userMsg,
      type: 'added',
    });

    try {
      // Send to backend
      const result = await api.chat.sendMessage({
        sessionId: this._currentSessionId,
        content,
        options,
      });

      // Update session ID if new session was created
      if (result.sessionId !== this._currentSessionId) {
        // This shouldn't happen if we created session first, but handle it
        this._currentSessionId = result.sessionId;
      }
    } catch (error) {
      this._setGenerating(false);
      this._onDidError.fire({
        code: 'SEND_ERROR',
        message: error instanceof Error ? error.message : 'Failed to send message',
      });
    }
  }

  async cancel(): Promise<void> {
    if (!this._currentSessionId || !this._isGenerating) return;

    await api.chat.cancel(this._currentSessionId);
    this._setGenerating(false);
  }

  // ============ Loading State ============

  private _setGenerating(generating: boolean): void {
    if (this._isGenerating === generating) return;
    this._isGenerating = generating;
    this._onDidChangeLoading.fire(generating);
  }

  // ============ Lifecycle ============

  dispose(): void {
    if (this._streamUnsubscribe) {
      this._streamUnsubscribe();
      this._streamUnsubscribe = null;
    }

    this._sessionsById.clear();
    this._sessionOrder = [];
    this._messagesById.clear();
    this._messageOrderBySession.clear();
    this._disposables.dispose();
  }
}

// ============ Singleton ============

let chatServiceInstance: ChatService | null = null;

export function getChatService(): ChatService {
  if (!chatServiceInstance) {
    chatServiceInstance = new ChatService();
  }
  return chatServiceInstance;
}

export function disposeChatService(): void {
  if (chatServiceInstance) {
    chatServiceInstance.dispose();
    chatServiceInstance = null;
  }
}
