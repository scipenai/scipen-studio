import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  IMConnectionStateDTO,
  IMErrorDTO,
  IMMessagesChangedDTO,
  IMTypingDTO,
} from '../../../shared/api-types';
import { createLogger } from '../services/LoggerService';
import { getStudioIMService } from '../services/ServiceRegistry';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('IMHandlers');
let subscribed = false;

function broadcast(channel: IpcChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function ensureForwarding(): void {
  if (subscribed) return;
  subscribed = true;
  const service = getStudioIMService();
  service.onDidChangeState((payload: IMConnectionStateDTO) => {
    broadcast(IpcChannel.IM_StateChanged, payload);
  });
  service.onDidChangeMessages((payload: IMMessagesChangedDTO) => {
    broadcast(IpcChannel.IM_MessagesChanged, payload);
  });
  service.onDidChangeTyping((payload: IMTypingDTO) => {
    broadcast(IpcChannel.IM_TypingChanged, payload);
  });
  service.onDidError((payload: IMErrorDTO) => {
    broadcast(IpcChannel.IM_Error, payload);
  });
}

export function registerIMHandlers(): void {
  ensureForwarding();
  const service = getStudioIMService();
  const handlers = createTypedHandlers(
    {
      [IpcChannel.IM_Connect]: async (config) => service.connect(config),
      [IpcChannel.IM_Disconnect]: () => service.disconnect(),
      [IpcChannel.IM_GetSnapshot]: () => service.getSnapshot(),
      [IpcChannel.IM_ListConversations]: async (params) => service.listConversations(params),
      [IpcChannel.IM_CreateConversation]: async (params) => service.createConversation(params),
      [IpcChannel.IM_GetConversationMembers]: async (baseUrl, token, conversationId) =>
        service.getConversationMembersForConfig(baseUrl, token, conversationId),
      [IpcChannel.IM_GetBotUserId]: async (baseUrl: string, token: string) => {
        const BOT_USERID_TIMEOUT_MS = 5000;
        const result = await Promise.race([
          service.listUsersForConfig(baseUrl, token),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getBotUserId timeout (5s)')), BOT_USERID_TIMEOUT_MS)
          ),
        ]);
        const bots = result.filter((u) => u.role === 'bot');
        if (bots.length === 0) throw new Error('No bot user found in IM server');
        return bots[0].id;
      },
      [IpcChannel.IM_SendMessage]: async (params) => service.sendMessage(params),
      [IpcChannel.IM_UploadAttachment]: async (params) => service.uploadAttachment(params),
      [IpcChannel.IM_SendTyping]: (conversationId) => service.sendTyping(conversationId),
    },
    { logErrors: true }
  );
  handlers.registerAll();
  logger.info('[IPC] IM handlers registered');
}
