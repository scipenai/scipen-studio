/**
 * @file Chat IPC handlers (Type-Safe)
 * @description Handles chat system (Ask mode) IPC requests: messaging, session management.
 * @depends IChatOrchestrator
 * @security All params validated via Zod schemas
 */

import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { SendMessageOptions } from '../../../shared/types/chat';
import { createLogger } from '../services/LoggerService';
import type { IChatOrchestrator } from '../services/interfaces/IChatOrchestrator';
import { channelSchemas, registerTypedHandler } from './typedIpc';

const logger = createLogger('ChatHandlers');

// ====== Validation Schemas ======

// Send message options schema
const sendMessageOptionsSchema = z.object({
  knowledgeBaseId: z.string().max(100).optional(),
});

// Send message params schema
const sendMessageParamsSchema = z.object({
  sessionId: z.string().max(100).nullable(),
  content: z.string().min(1).max(100000), // max 100KB
  options: sendMessageOptionsSchema,
});

// Register schemas for Chat channels
channelSchemas.set(IpcChannel.Chat_SendMessage, z.tuple([sendMessageParamsSchema]));

channelSchemas.set(
  IpcChannel.Chat_Cancel,
  z.tuple([
    z
      .string()
      .min(1)
      .max(100), // sessionId
  ])
);

channelSchemas.set(IpcChannel.Chat_GetSessions, z.tuple([]));

channelSchemas.set(
  IpcChannel.Chat_GetMessages,
  z.tuple([
    z.object({
      sessionId: z.string().min(1).max(100),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.number().int().optional(),
    }),
  ])
);

channelSchemas.set(
  IpcChannel.Chat_DeleteSession,
  z.tuple([
    z
      .string()
      .min(1)
      .max(100), // sessionId
  ])
);

channelSchemas.set(
  IpcChannel.Chat_RenameSession,
  z.tuple([
    z.object({
      sessionId: z.string().min(1).max(100),
      title: z.string().min(1).max(200),
    }),
  ])
);

channelSchemas.set(
  IpcChannel.Chat_CreateSession,
  z.tuple([
    z
      .string()
      .max(100)
      .optional(), // knowledgeBaseId
  ])
);

// ====== Handler Dependencies ======

export interface ChatHandlersDeps {
  chatOrchestrator: IChatOrchestrator;
}

// ====== Handler Registration ======

/**
 * Register unified chat IPC handlers.
 * @sideeffect Registers handlers on ipcMain for chat operations
 */
export function registerChatHandlers(deps: ChatHandlersDeps): void {
  const { chatOrchestrator } = deps;

  logger.info('[ChatHandlers] Registering handlers...');

  // Chat_SendMessage - requires event.sender for streaming
  registerTypedHandler(IpcChannel.Chat_SendMessage, async (event, params) => {
    const webContents = event.sender;
    const result = await chatOrchestrator.sendMessage(
      params.sessionId,
      params.content,
      params.options as SendMessageOptions,
      webContents
    );
    return result;
  });

  // Chat_Cancel
  registerTypedHandler(IpcChannel.Chat_Cancel, async (_event, sessionId) => {
    chatOrchestrator.cancelGeneration(sessionId);
    return { success: true };
  });

  // Chat_GetSessions
  registerTypedHandler(IpcChannel.Chat_GetSessions, async () => {
    const sessions = chatOrchestrator.getSessions();
    return { sessions };
  });

  // Chat_GetMessages
  registerTypedHandler(IpcChannel.Chat_GetMessages, async (_event, params) => {
    const result = chatOrchestrator.getMessages(params.sessionId, params.limit, params.before);
    return {
      sessionId: params.sessionId,
      messages: result.messages,
      hasMore: result.hasMore,
    };
  });

  // Chat_DeleteSession
  registerTypedHandler(IpcChannel.Chat_DeleteSession, async (_event, sessionId) => {
    const success = chatOrchestrator.deleteSession(sessionId);
    return { success, error: success ? undefined : 'Session not found' };
  });

  // Chat_RenameSession
  registerTypedHandler(IpcChannel.Chat_RenameSession, async (_event, params) => {
    const success = chatOrchestrator.renameSession(params.sessionId, params.title);
    return { success, error: success ? undefined : 'Session not found' };
  });

  // Chat_CreateSession
  registerTypedHandler(IpcChannel.Chat_CreateSession, async (_event, knowledgeBaseId) => {
    return chatOrchestrator.createSession(knowledgeBaseId ?? undefined);
  });

  logger.info('[ChatHandlers] Handlers registered');
}
