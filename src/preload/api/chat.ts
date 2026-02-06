/**
 * @file Chat API - Chat API Module
 * @description Provides IPC interfaces for chat message sending, session management, streaming event listeners
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ChatGetMessagesParams,
  ChatMessage,
  ChatMessagesResult,
  ChatOperationResult,
  ChatRenameSessionParams,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatSession,
  ChatSessionsResult,
  ChatStreamEvent,
} from '../../../shared/types/chat';
import { createSafeListener } from './_shared';

export const chatApi = {
  /**
   * Send a message and get AI response
   * @sideeffect Creates or updates session, persists message to database
   * @throws {Error} When IPC call fails or session creation fails
   */
  sendMessage: (params: ChatSendMessageParams): Promise<ChatSendMessageResult> =>
    ipcRenderer.invoke(IpcChannel.Chat_SendMessage, params),

  /**
   * Cancel current generation
   * @sideeffect Stops streaming response generation
   */
  cancel: (sessionId: string): Promise<ChatOperationResult> =>
    ipcRenderer.invoke(IpcChannel.Chat_Cancel, sessionId),

  getSessions: (): Promise<ChatSessionsResult> => ipcRenderer.invoke(IpcChannel.Chat_GetSessions),

  getMessages: (params: ChatGetMessagesParams): Promise<ChatMessagesResult> =>
    ipcRenderer.invoke(IpcChannel.Chat_GetMessages, params),

  /**
   * Delete a chat session
   * @sideeffect Removes session and all messages from database
   */
  deleteSession: (sessionId: string): Promise<ChatOperationResult> =>
    ipcRenderer.invoke(IpcChannel.Chat_DeleteSession, sessionId),

  renameSession: (params: ChatRenameSessionParams): Promise<ChatOperationResult> =>
    ipcRenderer.invoke(IpcChannel.Chat_RenameSession, params),

  /**
   * Create a new chat session
   * @sideeffect Creates new session record in database
   */
  createSession: (knowledgeBaseId?: string): Promise<ChatSession> =>
    ipcRenderer.invoke(IpcChannel.Chat_CreateSession, knowledgeBaseId),

  /**
   * Listen to streaming events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onStream: createSafeListener<ChatStreamEvent>(IpcChannel.Chat_Stream),
};

// Re-export types for convenience
export type {
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatOperationResult,
  ChatMessagesResult,
  ChatSessionsResult,
};
