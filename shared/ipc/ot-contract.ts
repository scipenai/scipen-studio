/**
 * @file OT (Operational Transformation) IPC Contract
 * @description OT connection, file ops, collaborative apply types and channel contract
 * @depends ipc/channels, ipc/im-contract (CollaborationBackend)
 */

import type { OTProject } from '@scipen/ot-protocol';
import { IpcChannel } from './channels';
import type { CollaborationBackend } from './im-contract';

// ====== OT Connection Types ======

export type StudioOTConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type StudioOTClientState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'SYNCHRONIZED'
  | 'WAITING_FOR_ACK';
export type StudioOTRawOp = { retain?: number; insert?: string; delete?: number };

// ====== OT Project/File Types ======

export interface StudioOTConfigureParams {
  baseUrl: string;
  token: string;
}

export interface StudioOTProject {
  id: string;
  name: string;
  root_path: string;
  export_dir: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

/** OT project list summary (omits export_dir, includes role). */
export interface StudioOTProjectSummaryDTO {
  id: string;
  name: string;
  workspace: string;
  root_path: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface StudioOTProjectFolderDTO {
  id: string;
  project_id: string;
  folder_path: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StudioOTProjectFileDTO {
  id: string;
  project_id: string;
  file_path: string;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StudioOTProjectSnapshotDTO {
  project: StudioOTProject;
  folders: StudioOTProjectFolderDTO[];
  files: StudioOTProjectFileDTO[];
}

// ====== OT Operation Params ======

export interface StudioOTOpenLocalProjectParams {
  root_path: string;
  name?: string;
  files: Array<{ file_path: string; content: string }>;
  folders?: string[];
  workspace?: string;
}

export interface StudioOTJoinFileParams {
  projectId: string;
  fileId: string;
}

export interface StudioOTSubmitFileOpParams {
  projectId: string;
  fileId: string;
  version: number;
  ops: StudioOTRawOp[];
}

/** Discriminated union for OT submit results. */
export type StudioOTSubmitFileOpResult =
  | { status: 'applied'; version: number }
  | { status: 'buffered'; version: number }
  | { status: 'desynced'; version: number };

export interface StudioOTCreateFileParams {
  projectId: string;
  file_path: string;
  content?: string;
}

export interface StudioOTCreateFolderParams {
  projectId: string;
  folder_path: string;
}

export interface StudioOTRenameFileParams {
  projectId: string;
  fileId: string;
  file_path: string;
}

export interface StudioOTRenameFolderParams {
  projectId: string;
  folderId: string;
  folder_path: string;
}

// ====== OT Event DTOs ======

export interface OTConnectionStateDTO {
  state: StudioOTConnectionState;
}

export interface OTStateChangedDTO {
  state: StudioOTClientState;
  projectId: string | null;
  fileId: string | null;
  version: number;
}

export interface OTRemoteUpdateDTO {
  projectId: string;
  fileId: string;
  /** Relative file path (forward slashes). */
  filePath: string;
  content: string;
  version: number;
  /** Transformed incremental ops, suitable for precise editor application. */
  ops?: StudioOTRawOp[];
  /** User ID that issued this operation; distinguishes human vs. AI bot. */
  userId?: string;
}

export interface OTApplyBotEditParams {
  projectId: string;
  fileId: string;
  newContent: string;
  originalContent?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type CollaborativeApplyStatus = 'applied' | 'not_applied' | 'transport_failed';

export interface CollaborativeApplyOutcomeDTO {
  backend: CollaborationBackend;
  status: CollaborativeApplyStatus;
  changed: boolean;
  projectId: string;
  fileId: string;
  filePath?: string | null;
  version?: number | null;
  reason?: string | null;
}

export interface OTFileEventDTO {
  projectId: string;
  action: 'created' | 'renamed' | 'deleted';
  entityType: 'file' | 'folder';
  userId: string;
  fileId?: string;
  folderId?: string;
  filePath: string;
}

export interface OTErrorDTO {
  scope:
    | 'configure'
    | 'poll'
    | 'openLocalProject'
    | 'joinFile'
    | 'submitFileOp'
    | 'fileMutation'
    | 'reconnect';
  message: string;
  /** Structured error code for renderer-side branching (e.g. LOCAL_EDITS_LOST). */
  code?: string;
}

// ====== Channel Contract ======

export interface IPCOtContract {
  [IpcChannel.OT_Configure]: {
    args: [config: StudioOTConfigureParams];
    result: OTConnectionStateDTO;
  };
  [IpcChannel.OT_SetBotUserId]: {
    args: [userId: string];
    result: void;
  };
  [IpcChannel.OT_Disconnect]: {
    args: [];
    result: void;
  };
  [IpcChannel.OT_OpenLocalProject]: {
    args: [params: StudioOTOpenLocalProjectParams];
    result: StudioOTProjectSnapshotDTO;
  };
  [IpcChannel.OT_GetProjectSnapshot]: {
    args: [projectId: string];
    result: StudioOTProjectSnapshotDTO;
  };
  [IpcChannel.OT_GetProjectFile]: {
    args: [projectId: string, fileId: string];
    result: StudioOTProjectFileDTO;
  };
  [IpcChannel.OT_JoinFile]: {
    args: [params: StudioOTJoinFileParams];
    result: StudioOTProjectFileDTO;
  };
  [IpcChannel.OT_SubmitFileOp]: {
    args: [params: StudioOTSubmitFileOpParams];
    result: StudioOTSubmitFileOpResult;
  };
  [IpcChannel.OT_ApplyBotEdit]: {
    args: [params: OTApplyBotEditParams];
    result: CollaborativeApplyOutcomeDTO;
  };
  [IpcChannel.OT_CreateFile]: {
    args: [params: StudioOTCreateFileParams];
    result: StudioOTProjectFileDTO;
  };
  [IpcChannel.OT_CreateFolder]: {
    args: [params: StudioOTCreateFolderParams];
    result: StudioOTProjectFolderDTO;
  };
  [IpcChannel.OT_RenameFile]: {
    args: [params: StudioOTRenameFileParams];
    result: StudioOTProjectFileDTO;
  };
  [IpcChannel.OT_RenameFolder]: {
    args: [params: StudioOTRenameFolderParams];
    result: StudioOTProjectFolderDTO;
  };
  [IpcChannel.OT_DeleteFile]: {
    args: [projectId: string, fileId: string];
    result: { success: boolean };
  };
  [IpcChannel.OT_DeleteFolder]: {
    args: [projectId: string, folderId: string];
    result: { success: boolean };
  };
  [IpcChannel.OT_ListProjects]: {
    args: [workspace: string | null];
    result: StudioOTProjectSummaryDTO[];
  };
  [IpcChannel.OT_UpdateProject]: {
    args: [projectId: string, updates: { name?: string; workspace?: string }];
    result: { project: OTProject };
  };
}
