/**
 * @file IChatOrchestrator - Chat orchestration contract
 * @description Core interface for Ask (RAG) mode messaging and session lifecycle
 * @depends ChatOrchestrator
 */

import type { WebContents } from 'electron';
import type { ChatMessage, ChatSession, SendMessageOptions } from '../../../../shared/types/chat';
import type { IDisposable } from '../ServiceContainer';

/**
 * Chat orchestration interface.
 */
export interface IChatOrchestrator extends IDisposable {
  // ====== Messaging ======

  /**
   * Sends a message and streams responses via WebContents.
   * @param sessionId Session id (null to create new)
   * @param content Message content
   * @param options Send options (knowledge context)
   * @param webContents WebContents for streaming
   * @returns Session id and user message id
   * @sideeffect Persists message and emits streaming updates
   */
  sendMessage(
    sessionId: string | null,
    content: string,
    options: SendMessageOptions,
    webContents: WebContents
  ): Promise<{ sessionId: string; userMessageId: string }>;

  /**
   * Cancels in-flight generation for a session.
   * @param sessionId Session id
   * @sideeffect Stops streaming output
   */
  cancelGeneration(sessionId: string): void;

  // ====== Session Management ======

  /**
   * Creates a new session.
   * @param knowledgeBaseId Optional knowledge base id
   * @returns Newly created session
   */
  createSession(knowledgeBaseId?: string): ChatSession;

  /**
   * Returns all sessions (sorted by last update).
   */
  getSessions(): ChatSession[];

  /**
   * Returns a session by id.
   * @param sessionId Session id
   * @returns Session or undefined when missing
   */
  getSession(sessionId: string): ChatSession | undefined;

  /**
   * Returns paged messages for a session.
   * @param sessionId Session id
   * @param limit Optional page size
   * @param before Optional cursor for pagination
   * @returns Messages and paging indicator
   */
  getMessages(
    sessionId: string,
    limit?: number,
    before?: number
  ): { messages: ChatMessage[]; hasMore: boolean };

  /**
   * Deletes a session.
   * @param sessionId Session id
   * @returns Whether deletion succeeded
   * @sideeffect Removes session and associated messages
   */
  deleteSession(sessionId: string): boolean;

  /**
   * Renames a session.
   * @param sessionId Session id
   * @param title New title
   * @returns Whether rename succeeded
   * @sideeffect Updates session metadata
   */
  renameSession(sessionId: string, title: string): boolean;

  // ====== Status ======

  /**
   * Checks whether a session is currently generating.
   * @param sessionId Session id
   * @returns Whether generation is in progress
   */
  isGenerating(sessionId: string): boolean;
}
