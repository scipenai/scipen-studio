import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { IPCResult } from '../../../shared/api-types';
import type {
  CollaborativeApplyOutcomeDTO,
  OTConnectionStateDTO,
  OTErrorDTO,
  OTFileEventDTO,
  OTApplyBotEditParams,
  OTRemoteUpdateDTO,
  OTStateChangedDTO,
  StudioOTConfigureParams,
  StudioOTCreateFileParams,
  StudioOTCreateFolderParams,
  StudioOTJoinFileParams,
  StudioOTProjectFileDTO,
  StudioOTProjectFolderDTO,
  StudioOTProjectSnapshotDTO,
  StudioOTRenameFileParams,
  StudioOTRenameFolderParams,
  StudioOTSubmitFileOpParams,
  StudioOTSubmitFileOpResult,
} from '../../../shared/api-types';
import { createSafeListener } from './_shared';

export const otApi = {
  configure: (config: StudioOTConfigureParams) =>
    ipcRenderer.invoke(IpcChannel.OT_Configure, config) as Promise<OTConnectionStateDTO>,
  disconnect: () => ipcRenderer.invoke(IpcChannel.OT_Disconnect) as Promise<void>,
  openLocalProject: (params: {
    root_path: string;
    name?: string;
    files: Array<{ file_path: string; content: string }>;
    folders?: string[];
    workspace?: string;
  }) =>
    ipcRenderer.invoke(
      IpcChannel.OT_OpenLocalProject,
      params
    ) as Promise<StudioOTProjectSnapshotDTO>,
  getProjectSnapshot: (projectId: string) =>
    ipcRenderer.invoke(
      IpcChannel.OT_GetProjectSnapshot,
      projectId
    ) as Promise<StudioOTProjectSnapshotDTO>,
  getProjectFile: (projectId: string, fileId: string) =>
    ipcRenderer.invoke(
      IpcChannel.OT_GetProjectFile,
      projectId,
      fileId
    ) as Promise<StudioOTProjectFileDTO>,
  joinFile: (params: StudioOTJoinFileParams) =>
    ipcRenderer.invoke(IpcChannel.OT_JoinFile, params) as Promise<
      StudioOTProjectFileDTO & { lastEditUserId?: string }
    >,
  submitFileOp: (params: StudioOTSubmitFileOpParams) =>
    ipcRenderer.invoke(IpcChannel.OT_SubmitFileOp, params) as Promise<StudioOTSubmitFileOpResult>,
  applyBotEdit: (params: OTApplyBotEditParams) =>
    ipcRenderer.invoke(IpcChannel.OT_ApplyBotEdit, params) as Promise<CollaborativeApplyOutcomeDTO>,
  createFile: (params: StudioOTCreateFileParams) =>
    ipcRenderer.invoke(IpcChannel.OT_CreateFile, params) as Promise<StudioOTProjectFileDTO>,
  createFolder: (params: StudioOTCreateFolderParams) =>
    ipcRenderer.invoke(IpcChannel.OT_CreateFolder, params) as Promise<StudioOTProjectFolderDTO>,
  renameFile: (params: StudioOTRenameFileParams) =>
    ipcRenderer.invoke(IpcChannel.OT_RenameFile, params) as Promise<StudioOTProjectFileDTO>,
  renameFolder: (params: StudioOTRenameFolderParams) =>
    ipcRenderer.invoke(IpcChannel.OT_RenameFolder, params) as Promise<StudioOTProjectFolderDTO>,
  deleteFile: (projectId: string, fileId: string) =>
    ipcRenderer.invoke(IpcChannel.OT_DeleteFile, projectId, fileId) as Promise<{
      success: boolean;
    }>,
  deleteFolder: (projectId: string, folderId: string) =>
    ipcRenderer.invoke(IpcChannel.OT_DeleteFolder, projectId, folderId) as Promise<{
      success: boolean;
    }>,
  listProjects: (workspace?: string) =>
    ipcRenderer.invoke(IpcChannel.OT_ListProjects, workspace ?? null) as Promise<
      import('../../../shared/api-types').StudioOTProjectSummaryDTO[]
    >,
  updateProject: (projectId: string, updates: { name?: string; workspace?: string }) =>
    ipcRenderer.invoke(IpcChannel.OT_UpdateProject, projectId, updates) as Promise<
      IPCResult<typeof IpcChannel.OT_UpdateProject>
    >,
  onStateChanged: createSafeListener<OTStateChangedDTO>(IpcChannel.OT_StateChanged),
  onConnectionChanged: createSafeListener<OTConnectionStateDTO>(IpcChannel.OT_ConnectionChanged),
  onRemoteUpdate: createSafeListener<OTRemoteUpdateDTO>(IpcChannel.OT_RemoteUpdate),
  onFileEvent: createSafeListener<OTFileEventDTO>(IpcChannel.OT_FileEvent),
  onError: createSafeListener<OTErrorDTO>(IpcChannel.OT_Error),
};
