import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  OverleafLiveConfigureParams,
  OverleafLiveConnectionStateDTO,
  OverleafLiveDocStateDTO,
  OverleafLiveEntityResultDTO,
  OverleafLiveErrorDTO,
  OverleafLiveJoinDocParams,
  OverleafLiveCreateEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveRenameEntityParams,
  OverleafLiveRemotePatchDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveSubmitPatchesParams,
  OverleafLiveTreeChangedDTO,
  OverleafLiveUploadFileParams,
} from '../../../shared/api-types';
import { createSafeListener } from './_shared';

export const overleafLiveApi = {
  configure: (config: OverleafLiveConfigureParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_Configure,
      config
    ) as Promise<OverleafLiveConnectionStateDTO>,
  disconnect: () => ipcRenderer.invoke(IpcChannel.OverleafLive_Disconnect) as Promise<void>,
  getState: () =>
    ipcRenderer.invoke(IpcChannel.OverleafLive_GetState) as Promise<OverleafLiveStateChangedDTO>,
  joinDoc: (params: OverleafLiveJoinDocParams) =>
    ipcRenderer.invoke(IpcChannel.OverleafLive_JoinDoc, params) as Promise<OverleafLiveDocStateDTO>,
  submitPatches: (params: OverleafLiveSubmitPatchesParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_SubmitPatches,
      params
    ) as Promise<OverleafLiveRemotePatchDTO>,
  createEntity: (params: OverleafLiveCreateEntityParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_CreateEntity,
      params
    ) as Promise<OverleafLiveEntityResultDTO>,
  renameEntity: (params: OverleafLiveRenameEntityParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_RenameEntity,
      params
    ) as Promise<OverleafLiveEntityResultDTO>,
  moveEntity: (params: OverleafLiveMoveEntityParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_MoveEntity,
      params
    ) as Promise<OverleafLiveEntityResultDTO>,
  deleteEntity: (params: OverleafLiveDeleteEntityParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_DeleteEntity,
      params
    ) as Promise<OverleafLiveEntityResultDTO>,
  uploadFile: (params: OverleafLiveUploadFileParams) =>
    ipcRenderer.invoke(
      IpcChannel.OverleafLive_UploadFile,
      params
    ) as Promise<OverleafLiveEntityResultDTO>,
  onConnectionChanged: createSafeListener<OverleafLiveConnectionStateDTO>(
    IpcChannel.OverleafLive_ConnectionChanged
  ),
  onStateChanged: createSafeListener<OverleafLiveStateChangedDTO>(
    IpcChannel.OverleafLive_StateChanged
  ),
  onRemotePatch: createSafeListener<OverleafLiveRemotePatchDTO>(
    IpcChannel.OverleafLive_RemotePatch
  ),
  onTreeChanged: createSafeListener<OverleafLiveTreeChangedDTO>(
    IpcChannel.OverleafLive_TreeChanged
  ),
  onError: createSafeListener<OverleafLiveErrorDTO>(IpcChannel.OverleafLive_Error),
};
