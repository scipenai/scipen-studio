/**
 * @file ChatSessionStore - Chat Session Memory Store
 * @description Manages CRUD operations for chat sessions and messages using Event-Driven pattern
 * @depends ChatMessage, ChatSession, IDisposable
 */

import { randomUUID } from 'crypto';
import type { ChatMessage, ChatSession, ChatSessionStatus } from '../../../../shared/types/chat';
import { createLogger } from '../LoggerService';
import type { IDisposable } from '../ServiceContainer';

const logger = createLogger('ChatSessionStore');

/**
 * Internal session data (includes runtime state)
 */
export interface InternalChatSession extends ChatSession {
  /** Abort controller (for cancelling generation) */
  abortController: AbortController | null;
}

/**
 * Chat session storage
 */
export class ChatSessionStore implements IDisposable {
  /** Session storage (id -> session) */
  private sessions: Map<string, InternalChatSession> = new Map();
  /** Message storage (sessionId -> messages[]) */
  private messages: Map<string, ChatMessage[]> = new Map();
  /** Session ordering (by update time descending) */
  private sessionOrder: string[] = [];

  // ============ Session Operations ============

  /**
   * Create new session
   */
  createSession(knowledgeBaseId?: string): InternalChatSession {
    const now = Date.now();
    const sessionId = randomUUID();

    const session: InternalChatSession = {
      id: sessionId,
      title: 'New Conversation',
      status: 'idle',
      knowledgeBaseId,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      abortController: null,
    };

    this.sessions.set(sessionId, session);
    this.messages.set(sessionId, []);
    this.sessionOrder.unshift(sessionId);

    logger.info(`[ChatSessionStore] Created session: ${sessionId}`);
    return session;
  }

  /**
   * Get session
   */
  getSession(sessionId: string): InternalChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions (by update time descending)
   */
  getSessions(): ChatSession[] {
    return this.sessionOrder
      .map((id) => this.sessions.get(id))
      .filter((s): s is InternalChatSession => !!s)
      .map((s) => this.toPublicSession(s));
  }

  /**
   * Update session status
   */
  updateSessionStatus(sessionId: string, status: ChatSessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.updatedAt = Date.now();
      this.moveToTop(sessionId);
    }
  }

  /**
   * Update session title
   */
  renameSession(sessionId: string, title: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.title = title;
    session.updatedAt = Date.now();
    logger.info(`[ChatSessionStore] Renamed session: ${sessionId} -> ${title}`);
    return true;
  }

  /**
   * Delete session
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Cancel ongoing generation
    if (session.abortController) {
      session.abortController.abort();
    }

    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.sessionOrder = this.sessionOrder.filter((id) => id !== sessionId);

    logger.info(`[ChatSessionStore] Deleted session: ${sessionId}`);
    return true;
  }

  // ============ Message Operations ============

  /**
   * Add message
   */
  addMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'sessionId' | 'timestamp'>
  ): ChatMessage {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fullMessage: ChatMessage = {
      ...message,
      id: randomUUID(),
      sessionId,
      timestamp: Date.now(),
    };

    const sessionMessages = this.messages.get(sessionId) || [];
    sessionMessages.push(fullMessage);
    this.messages.set(sessionId, sessionMessages);

    // Update session
    session.messageCount = sessionMessages.length;
    session.updatedAt = Date.now();
    this.moveToTop(sessionId);

    // Auto-generate title (first user message)
    if (message.role === 'user' && session.title === 'New Conversation') {
      session.title = this.generateTitle(message.content);
    }

    return fullMessage;
  }

  /**
   * Get messages
   */
  getMessages(
    sessionId: string,
    limit?: number,
    before?: number
  ): { messages: ChatMessage[]; hasMore: boolean } {
    const sessionMessages = this.messages.get(sessionId) || [];

    let filteredMessages = sessionMessages;
    if (before !== undefined) {
      filteredMessages = sessionMessages.filter((m) => m.timestamp < before);
    }

    if (limit !== undefined && filteredMessages.length > limit) {
      return {
        messages: filteredMessages.slice(-limit),
        hasMore: true,
      };
    }

    return {
      messages: filteredMessages,
      hasMore: false,
    };
  }

  /**
   * Update message
   */
  updateMessage(sessionId: string, messageId: string, updates: Partial<ChatMessage>): boolean {
    const sessionMessages = this.messages.get(sessionId);
    if (!sessionMessages) return false;

    const index = sessionMessages.findIndex((m) => m.id === messageId);
    if (index === -1) return false;

    sessionMessages[index] = { ...sessionMessages[index], ...updates };

    const session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = Date.now();
    }

    return true;
  }

  /**
   * Append content to last assistant message
   */
  appendToLastAssistantMessage(sessionId: string, content: string): ChatMessage | null {
    const sessionMessages = this.messages.get(sessionId);
    if (!sessionMessages || sessionMessages.length === 0) return null;

    // Find last assistant message
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === 'assistant') {
        sessionMessages[i].content += content;
        return sessionMessages[i];
      }
    }

    return null;
  }

  // ============ AbortController ============

  /**
   * Set abort controller
   */
  setAbortController(sessionId: string, controller: AbortController): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController = controller;
    }
  }

  /**
   * Clear abort controller
   */
  clearAbortController(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController = null;
    }
  }

  /**
   * Abort session
   */
  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.abortController) return false;

    session.abortController.abort();
    session.abortController = null;
    return true;
  }

  // ============ Helpers ============

  /**
   * Move session to top of list
   */
  private moveToTop(sessionId: string): void {
    this.sessionOrder = [sessionId, ...this.sessionOrder.filter((id) => id !== sessionId)];
  }

  /**
   * Convert to public session type (removes internal fields)
   */
  private toPublicSession(session: InternalChatSession): ChatSession {
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

  /**
   * Generate title from first message
   */
  private generateTitle(content: string): string {
    const maxLength = 30;
    const cleaned = content.replace(/\n/g, ' ').trim();
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxLength)}...`;
  }

  // ============ IDisposable ============

  dispose(): void {
    // Abort all ongoing generations
    for (const session of this.sessions.values()) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }

    this.sessions.clear();
    this.messages.clear();
    this.sessionOrder = [];
    logger.info('[ChatSessionStore] Disposed');
  }
}
