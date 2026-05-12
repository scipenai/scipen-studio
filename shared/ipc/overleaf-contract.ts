/**
 * @file Overleaf IPC Contract
 * @description Overleaf Auth/Project/Compile/Live/Replica types and channel contract
 * @depends ipc/channels, ipc/types
 */

import { IpcChannel } from './channels';
import type { OverleafProjectDTO } from './types';

// ====== Overleaf Config Types ======

export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
}

// ====== Overleaf Live Types ======

export type OverleafLiveConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'read_only_disconnected';

export interface StudioOverleafOffsetPatchDTO {
  offset: number;
  deleteCount: number;
  insertText: string;
}

export interface OverleafLiveConfigureParams {
  serverUrl: string;
  cookies: string;
  projectId: string;
  clientInstanceId?: string;
  sessionType?: 'user' | 'bot';
}

export interface OverleafLiveJoinDocParams {
  projectId: string;
  docId: string;
  fromVersion?: number;
}

export interface OverleafLiveSubmitPatchesParams {
  projectId: string;
  docId: string;
  baseVersion: number;
  requestId?: string;
  patches: StudioOverleafOffsetPatchDTO[];
}

export interface OverleafLiveDocStateDTO {
  projectId: string;
  docId: string;
  version: number;
  content: string;
  ranges?: Record<string, unknown>;
}

export interface OverleafLiveConnectionStateDTO {
  state: OverleafLiveConnectionState;
  projectId: string | null;
  sessionId: string | null;
}

export interface OverleafLiveStateChangedDTO {
  projectId: string | null;
  docId: string | null;
  version: number;
  content: string;
}

export interface OverleafLiveRemotePatchDTO {
  projectId: string;
  docId: string;
  version: number;
  content: string;
  patches: StudioOverleafOffsetPatchDTO[];
  ranges?: Record<string, unknown>;
  source?: string | null;
  /** Session type that issued this op ('user' | 'bot'); marks AI edits. */
  sessionType?: string;
}

export interface OverleafLiveTreeChangedDTO {
  projectId: string;
  event: Record<string, unknown>;
}

export interface OverleafLiveErrorDTO {
  scope: 'configure' | 'join' | 'submit' | 'ws' | 'gateway-host';
  message: string;
}

export interface OverleafLiveCreateEntityParams {
  projectId: string;
  entityType: 'doc' | 'folder';
  parentFolderId: string;
  name: string;
  content?: string;
}

export interface OverleafLiveRenameEntityParams {
  projectId: string;
  entityType: 'doc' | 'file' | 'folder';
  entityId: string;
  newName: string;
}

export interface OverleafLiveMoveEntityParams {
  projectId: string;
  entityType: 'doc' | 'file' | 'folder';
  entityId: string;
  targetFolderId: string;
}

export interface OverleafLiveDeleteEntityParams {
  projectId: string;
  entityType: 'doc' | 'file' | 'folder';
  entityId: string;
}

export interface OverleafLiveUploadFileParams {
  projectId: string;
  parentFolderId: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface OverleafLiveEntityResultDTO {
  success: boolean;
  entityId?: string;
  entityType?: 'doc' | 'file' | 'folder';
  error?: string;
}

// ====== Channel Contract ======

export interface IPCOverleafContract {
  // ============ Overleaf Auth ============
  [IpcChannel.OverleafAuth_Init]: {
    args: [config: OverleafConfig];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.OverleafAuth_TestConnection]: {
    args: [serverUrl: string];
    result: { success: boolean; message: string };
  };
  [IpcChannel.OverleafAuth_Login]: {
    args: [config: OverleafConfig];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.OverleafAuth_IsLoggedIn]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.OverleafAuth_GetCookies]: {
    args: [];
    result: string | null;
  };

  // ============ Overleaf Project ============
  [IpcChannel.OverleafProject_GetProjects]: {
    args: [];
    result: OverleafProjectDTO[];
  };
  [IpcChannel.OverleafProject_GetDetails]: {
    args: [projectId: string];
    result: unknown;
  };
  [IpcChannel.OverleafProject_Download]: {
    args: [projectId: string, projectName: string];
    result: {
      success: boolean;
      localPath?: string;
      files?: Array<{ file_path: string; content: string }>;
      folders?: string[];
      meta?: {
        overleafProjectId: string;
        serverUrl: string;
        projectName: string;
        docIdMap: Record<string, string>;
        downloadedAt: string;
      };
      error?: string;
    };
  };
  [IpcChannel.OverleafProject_FindLocalPath]: {
    args: [projectId: string];
    result: string | null;
  };
  [IpcChannel.OverleafProject_GetMeta]: {
    args: [localPath: string];
    result: {
      overleafProjectId: string;
      serverUrl: string;
      projectName: string;
      docIdMap: Record<string, string>;
      downloadedAt: string;
    } | null;
  };
  [IpcChannel.OverleafProject_UpdateDocIdMap]: {
    args: [localPath: string, docIdMap: Record<string, string>];
    result: boolean;
  };
  [IpcChannel.OverleafProject_SyncFile]: {
    args: [overleafProjectId: string, docId: string, localContent: string, baseCachePath: string];
    result: { status: string; remoteContent?: string; error?: string };
  };
  [IpcChannel.OverleafProject_SyncProject]: {
    args: [overleafProjectId: string, docIdMap: Record<string, string>, localRoot: string];
    result: Record<string, { status: string; remoteContent?: string; error?: string }>;
  };
  [IpcChannel.OverleafProject_SyncFileByPath]: {
    args: [
      overleafProjectId: string,
      relativePath: string,
      localContent: string,
      localRoot: string,
      docIdMap: Record<string, string>,
    ];
    result: { status: string; remoteContent?: string; newDocId?: string; error?: string };
  };
  [IpcChannel.OverleafProject_CreateAndSync]: {
    args: [
      overleafProjectId: string,
      fileName: string,
      parentFolderId: string,
      localContent: string,
      baseCachePath: string,
    ];
    result: { docId: string } | null;
  };

  // ============ Overleaf Live ============
  [IpcChannel.OverleafLive_Configure]: {
    args: [config: OverleafLiveConfigureParams];
    result: OverleafLiveConnectionStateDTO;
  };
  [IpcChannel.OverleafLive_Disconnect]: {
    args: [];
    result: void;
  };
  [IpcChannel.OverleafLive_GetState]: {
    args: [];
    result: OverleafLiveStateChangedDTO;
  };
  [IpcChannel.OverleafLive_JoinDoc]: {
    args: [params: OverleafLiveJoinDocParams];
    result: OverleafLiveDocStateDTO;
  };
  [IpcChannel.OverleafLive_SubmitPatches]: {
    args: [params: OverleafLiveSubmitPatchesParams];
    result: OverleafLiveRemotePatchDTO;
  };
  [IpcChannel.OverleafLive_CreateEntity]: {
    args: [params: OverleafLiveCreateEntityParams];
    result: OverleafLiveEntityResultDTO;
  };
  [IpcChannel.OverleafLive_RenameEntity]: {
    args: [params: OverleafLiveRenameEntityParams];
    result: OverleafLiveEntityResultDTO;
  };
  [IpcChannel.OverleafLive_MoveEntity]: {
    args: [params: OverleafLiveMoveEntityParams];
    result: OverleafLiveEntityResultDTO;
  };
  [IpcChannel.OverleafLive_DeleteEntity]: {
    args: [params: OverleafLiveDeleteEntityParams];
    result: OverleafLiveEntityResultDTO;
  };
  [IpcChannel.OverleafLive_UploadFile]: {
    args: [params: OverleafLiveUploadFileParams];
    result: OverleafLiveEntityResultDTO;
  };
}
