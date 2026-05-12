import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  OverleafLiveConnectionStateDTO,
  OverleafLiveErrorDTO,
  OverleafLiveRemotePatchDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveTreeChangedDTO,
} from '../../../shared/api-types';
import { createLogger } from '../services/LoggerService';
import { getCollaborationOwnerRegistry } from '../services/CollaborationOwnerRegistry';
import { getStudioOverleafLiveService } from '../services/ServiceRegistry';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('OverleafLiveHandlers');
let subscribed = false;

function ensureForwarding(): void {
  if (subscribed) return;
  subscribed = true;
  const service = getStudioOverleafLiveService();
  const ownerRegistry = getCollaborationOwnerRegistry();
  const sendToOwner = (channel: IpcChannel, payload: unknown) => {
    if (!ownerRegistry.getOwner('overleaf')) {
      return;
    }
    if (!ownerRegistry.sendToOwner('overleaf', channel, payload)) {
      logger.warn(`[IPC] No Overleaf owner window for ${channel}`);
    }
  };
  service.onDidChangeConnection((payload: OverleafLiveConnectionStateDTO) => {
    sendToOwner(IpcChannel.OverleafLive_ConnectionChanged, payload);
  });
  service.onDidChangeState((payload: OverleafLiveStateChangedDTO) => {
    sendToOwner(IpcChannel.OverleafLive_StateChanged, payload);
  });
  service.onDidReceiveRemotePatch((payload: OverleafLiveRemotePatchDTO) => {
    sendToOwner(IpcChannel.OverleafLive_RemotePatch, payload);
  });
  service.onDidReceiveTree((payload: OverleafLiveTreeChangedDTO) => {
    sendToOwner(IpcChannel.OverleafLive_TreeChanged, payload);
  });
  service.onDidError((payload: OverleafLiveErrorDTO) => {
    sendToOwner(IpcChannel.OverleafLive_Error, payload);
  });
}

export function registerOverleafLiveHandlers(deps: {
  getAuthService: () => import('../services/OverleafAuthService').OverleafAuthService;
}): void {
  ensureForwarding();
  const service = getStudioOverleafLiveService();
  // LiveService holds an AuthService reference so it can establish the bridge connection on its own
  // (works for both explicit login and auto-configure paths)
  service.setAuthService(deps.getAuthService());
  const handlers = createTypedHandlers(
    {
      [IpcChannel.OverleafLive_Configure]: async (config) => {
        // Renderer never holds real cookies (security policy); AuthService injects them here
        const realCookies = deps.getAuthService().getCookies();
        if (!realCookies) {
          return {
            state: 'read_only_disconnected' as const,
            projectId: config.projectId,
            sessionId: null,
          };
        }
        return service.configure({ ...config, cookies: realCookies });
      },
      [IpcChannel.OverleafLive_Disconnect]: () => service.disconnect(),
      [IpcChannel.OverleafLive_GetState]: () => service.getState(),
      [IpcChannel.OverleafLive_JoinDoc]: async (params) => service.joinDoc(params),
      [IpcChannel.OverleafLive_SubmitPatches]: async (params) => service.submitPatches(params),
      [IpcChannel.OverleafLive_CreateEntity]: async (params) => service.createEntity(params),
      [IpcChannel.OverleafLive_RenameEntity]: async (params) => service.renameEntity(params),
      [IpcChannel.OverleafLive_MoveEntity]: async (params) => service.moveEntity(params),
      [IpcChannel.OverleafLive_DeleteEntity]: async (params) => service.deleteEntity(params),
      [IpcChannel.OverleafLive_UploadFile]: async (params) => service.uploadFile(params),
    },
    { logErrors: true }
  );
  handlers.registerAll();
  logger.info('[IPC] OverleafLive handlers registered');
}
