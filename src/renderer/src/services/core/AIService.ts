/**
 * @file AIService.ts - AI Conversation Core Service
 * @description Manages AI sessions, messages, and polishing features (session functionality has been migrated to ChatService)
 * @depends shared/utils (Emitter, Event)
 * @deprecated Please use ChatService instead for session and message management
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import type { AIMessage } from '../../types';

// ============ Type Definitions ============

export interface SessionEntity {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionChangeEvent {
  readonly session: SessionEntity;
  readonly type: 'created' | 'deleted' | 'renamed' | 'switched';
}

export interface MessageChangeEvent {
  readonly sessionId: string;
  readonly message: AIMessage;
  readonly type: 'added' | 'updated' | 'cleared';
}

export interface PolishRequest {
  originalText: string;
  polishedText: string | null;
  isPolishing: boolean;
  selectionRange: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  filePath: string | null;
}

// ============ AIService Implementation ============

export class AIService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  // Normalized storage for efficient lookups
  private _sessionsById: Map<string, SessionEntity> = new Map();
  private _sessionOrder: string[] = [];
  private _messagesById: Map<string, AIMessage> = new Map();
  private _messageIdsBySession: Map<string, string[]> = new Map();
  private _currentSessionId: string | null = null;
  private _isLoading = false;
  private _polishRequest: PolishRequest | null = null;

  // Cached values for useSyncExternalStore to provide stable references
  private _cachedSessions: SessionEntity[] = [];
  private _cachedCurrentSession: SessionEntity | null = null;
  private _cachedCurrentMessages: AIMessage[] = [];

  // ============ Events ============

  private readonly _onDidCreateSession = new Emitter<SessionChangeEvent>();
  readonly onDidCreateSession: Event<SessionChangeEvent> = this._onDidCreateSession.event;

  private readonly _onDidDeleteSession = new Emitter<SessionChangeEvent>();
  readonly onDidDeleteSession: Event<SessionChangeEvent> = this._onDidDeleteSession.event;

  private readonly _onDidSwitchSession = new Emitter<string | null>();
  readonly onDidSwitchSession: Event<string | null> = this._onDidSwitchSession.event;

  private readonly _onDidRenameSession = new Emitter<SessionChangeEvent>();
  readonly onDidRenameSession: Event<SessionChangeEvent> = this._onDidRenameSession.event;

  private readonly _onDidAddMessage = new Emitter<MessageChangeEvent>();
  readonly onDidAddMessage: Event<MessageChangeEvent> = this._onDidAddMessage.event;

  private readonly _onDidUpdateMessage = new Emitter<MessageChangeEvent>();
  readonly onDidUpdateMessage: Event<MessageChangeEvent> = this._onDidUpdateMessage.event;

  private readonly _onDidClearMessages = new Emitter<string>();
  readonly onDidClearMessages: Event<string> = this._onDidClearMessages.event;

  private readonly _onDidChangeLoading = new Emitter<boolean>();
  readonly onDidChangeLoading: Event<boolean> = this._onDidChangeLoading.event;

  private readonly _onDidChangePolish = new Emitter<PolishRequest | null>();
  readonly onDidChangePolish: Event<PolishRequest | null> = this._onDidChangePolish.event;

  constructor() {
    this._disposables.add(this._onDidCreateSession);
    this._disposables.add(this._onDidDeleteSession);
    this._disposables.add(this._onDidSwitchSession);
    this._disposables.add(this._onDidRenameSession);
    this._disposables.add(this._onDidAddMessage);
    this._disposables.add(this._onDidUpdateMessage);
    this._disposables.add(this._onDidClearMessages);
    this._disposables.add(this._onDidChangeLoading);
    this._disposables.add(this._onDidChangePolish);
  }

  // ============ Getters ============

  get sessions(): SessionEntity[] {
    return this._cachedSessions;
  }

  get currentSessionId(): string | null {
    return this._currentSessionId;
  }

  get currentSession(): SessionEntity | null {
    return this._cachedCurrentSession;
  }

  get isLoading(): boolean {
    return this._isLoading;
  }

  get polishRequest(): PolishRequest | null {
    return this._polishRequest;
  }

  getSession(id: string): SessionEntity | undefined {
    return this._sessionsById.get(id);
  }

  getMessages(sessionId: string): AIMessage[] {
    const ids = this._messageIdsBySession.get(sessionId) ?? [];
    return ids.map((id) => this._messagesById.get(id)!).filter(Boolean);
  }

  getCurrentMessages(): AIMessage[] {
    return this._cachedCurrentMessages;
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
    const ids = this._messageIdsBySession.get(this._currentSessionId) ?? [];
    this._cachedCurrentMessages = ids.map((id) => this._messagesById.get(id)!).filter(Boolean);
  }

  // ============ Session Operations ============

  private _generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  createSession(title?: string): string {
    const id = this._generateId('session');
    const now = Date.now();

    const session: SessionEntity = {
      id,
      title: title || `New Conversation ${this._sessionOrder.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };

    this._sessionsById.set(id, session);
    this._sessionOrder.unshift(id);
    this._messageIdsBySession.set(id, []);
    this._currentSessionId = id;

    this._updateSessionsCache();
    this._updateCurrentSessionCache();
    this._updateCurrentMessagesCache();

    this._onDidCreateSession.fire({ session, type: 'created' });
    this._onDidSwitchSession.fire(id);

    return id;
  }

  switchSession(sessionId: string): void {
    if (!this._sessionsById.has(sessionId) || this._currentSessionId === sessionId) return;
    this._currentSessionId = sessionId;

    this._updateCurrentSessionCache();
    this._updateCurrentMessagesCache();

    this._onDidSwitchSession.fire(sessionId);
  }

  deleteSession(sessionId: string): void {
    const session = this._sessionsById.get(sessionId);
    if (!session) return;

    // Delete all messages for this session to prevent memory leaks
    const messageIds = this._messageIdsBySession.get(sessionId) ?? [];
    for (const msgId of messageIds) {
      this._messagesById.delete(msgId);
    }

    this._sessionsById.delete(sessionId);
    this._messageIdsBySession.delete(sessionId);
    this._sessionOrder = this._sessionOrder.filter((id) => id !== sessionId);

    this._updateSessionsCache();

    this._onDidDeleteSession.fire({ session, type: 'deleted' });

    // Switch to first remaining session if current one was deleted
    if (this._currentSessionId === sessionId) {
      this._currentSessionId = this._sessionOrder[0] ?? null;
      this._updateCurrentSessionCache();
      this._updateCurrentMessagesCache();
      this._onDidSwitchSession.fire(this._currentSessionId);
    }
  }

  renameSession(sessionId: string, title: string): void {
    const session = this._sessionsById.get(sessionId);
    if (!session) return;

    session.title = title;
    session.updatedAt = Date.now();

    this._updateSessionsCache();
    if (sessionId === this._currentSessionId) {
      this._updateCurrentSessionCache();
    }

    this._onDidRenameSession.fire({ session, type: 'renamed' });
  }

  // ============ Message Operations ============

  addMessage(message: AIMessage): void {
    if (!this._currentSessionId) return;

    const msgId = message.id || this._generateId('msg');
    const msg = { ...message, id: msgId };

    this._messagesById.set(msgId, msg);

    const msgIds = this._messageIdsBySession.get(this._currentSessionId) ?? [];
    msgIds.push(msgId);
    this._messageIdsBySession.set(this._currentSessionId, msgIds);

    // Update session timestamp and auto-generate title from first user message
    const session = this._sessionsById.get(this._currentSessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (msgIds.length === 1 && message.role === 'user') {
        const title = message.content.slice(0, 30);
        session.title = title + (message.content.length > 30 ? '...' : '');
        this._updateSessionsCache();
      }
    }

    this._updateCurrentMessagesCache();

    this._onDidAddMessage.fire({
      sessionId: this._currentSessionId,
      message: msg,
      type: 'added',
    });
  }

  updateLastMessage(content: string): void {
    if (!this._currentSessionId) return;

    const msgIds = this._messageIdsBySession.get(this._currentSessionId);
    if (!msgIds || msgIds.length === 0) return;

    const lastMsgId = msgIds[msgIds.length - 1];
    const msg = this._messagesById.get(lastMsgId);
    if (!msg) return;

    // Safety check: only allow updating assistant messages to prevent accidental overwrites of user messages
    if (msg.role !== 'assistant') {
      console.warn(
        '[AIService] updateLastMessage: Attempted to update non-assistant message, blocked'
      );
      return;
    }

    msg.content = content;

    this._updateCurrentMessagesCache();

    this._onDidUpdateMessage.fire({
      sessionId: this._currentSessionId,
      message: msg,
      type: 'updated',
    });
  }

  clearMessages(): void {
    if (!this._currentSessionId) return;

    const msgIds = this._messageIdsBySession.get(this._currentSessionId) ?? [];
    for (const id of msgIds) {
      this._messagesById.delete(id);
    }
    this._messageIdsBySession.set(this._currentSessionId, []);

    this._updateCurrentMessagesCache();

    this._onDidClearMessages.fire(this._currentSessionId);
  }

  // ============ Loading State ============

  setLoading(loading: boolean): void {
    if (this._isLoading === loading) return;
    this._isLoading = loading;
    this._onDidChangeLoading.fire(loading);
  }

  // ============ Polish Operations ============

  setPolishRequest(request: PolishRequest | null): void {
    this._polishRequest = request;
    this._onDidChangePolish.fire(request);
  }

  updatePolishResult(text: string): void {
    if (!this._polishRequest) return;
    this._polishRequest.polishedText = text;
    this._polishRequest.isPolishing = false;
    this._onDidChangePolish.fire(this._polishRequest);
  }

  clearPolishRequest(): void {
    this._polishRequest = null;
    this._onDidChangePolish.fire(null);
  }

  // ============ Lifecycle ============

  dispose(): void {
    this._sessionsById.clear();
    this._sessionOrder = [];
    this._messagesById.clear();
    this._messageIdsBySession.clear();
    this._disposables.dispose();
  }
}
