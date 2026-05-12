import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { getCollaborationOwnerRegistry } from '../services/CollaborationOwnerRegistry';
import { registerTypedHandler } from './typedIpc';

const logger = createLogger('CollaborationOwnerHandlers');

export function registerCollaborationOwnerHandlers(): void {
  registerTypedHandler(IpcChannel.CollaborationOwner_SetActive, (event, owner) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
    if (!windowId) {
      throw new Error('Failed to resolve owner window id');
    }
    return getCollaborationOwnerRegistry().setActive({
      ...owner,
      windowId,
    });
  });

  registerTypedHandler(IpcChannel.CollaborationOwner_Clear, (event, params) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
    getCollaborationOwnerRegistry().clear({
      backend: params.backend,
      windowId,
    });
  });
  logger.info('[IPC] Collaboration owner handlers registered');
}
