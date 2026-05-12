import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { ProjectConversationBindingChangedEvent } from '../../../shared/api-types';
import { getProjectConversationService } from '../services/ServiceRegistry';
import { createLogger } from '../services/LoggerService';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('ProjectConversationHandlers');
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
  const service = getProjectConversationService();
  service.onDidChangeBinding((payload: ProjectConversationBindingChangedEvent) => {
    broadcast(IpcChannel.ProjectConversation_BindingChanged, payload);
  });
}

export function registerProjectConversationHandlers(): void {
  ensureForwarding();
  const service = getProjectConversationService();
  const handlers = createTypedHandlers(
    {
      [IpcChannel.ProjectConversation_Resolve]: async (params) => service.resolveBinding(params),
      [IpcChannel.ProjectConversation_List]: async (params) => service.listBindings(params),
      [IpcChannel.ProjectConversation_Create]: async (params) => service.createBinding(params),
      [IpcChannel.ProjectConversation_SetDefault]: async (params) => {
        await service.setDefaultBinding(params.bindingId);
        return { success: true };
      },
    },
    { logErrors: true }
  );
  handlers.registerAll();
  logger.info('[IPC] Project conversation handlers registered');
}
