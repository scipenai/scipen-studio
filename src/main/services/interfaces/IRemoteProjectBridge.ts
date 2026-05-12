/**
 * @file IRemoteProjectBridge - Unified remote-project bridge contract
 * @description Abstracts over StudioOTService and StudioOverleafLiveService. The renderer goes
 *   through ProjectSessionManager for the active bridge and no longer distinguishes backends.
 *
 * Implementors:
 *   - OTProjectBridge (wraps StudioOTService)
 */

import type { Event } from '../../../../shared/utils';
import type { RemoteProjectBackend } from '../../../../shared/api-types';

// ====== Connection state ======

export type BridgeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'read_only_disconnected';

export interface BridgeConnectionStateDTO {
  state: BridgeConnectionState;
  projectId: string | null;
}

// ====== Project snapshot ======

export interface BridgeFileEntry {
  id: string;
  filePath: string;
  content?: string;
  version?: number;
}

export interface BridgeFolderEntry {
  id: string;
  folderPath: string;
}

export interface BridgeProjectSnapshot {
  projectId: string;
  projectName: string;
  files: BridgeFileEntry[];
  folders: BridgeFolderEntry[];
}

// ====== Document operations ======

export interface BridgeDocumentState {
  projectId: string;
  fileId: string;
  content: string;
  version: number;
}

// ====== File-tree operation params ======

export interface BridgeCreateFileParams {
  projectId: string;
  filePath: string;
  content?: string;
  /** Parent folder ID required by the Overleaf backend (OT backend addresses by file_path; ignored). */
  parentFolderId?: string;
}

export interface BridgeCreateFolderParams {
  projectId: string;
  folderPath: string;
  /** Parent folder ID required by the Overleaf backend (OT backend addresses by folder_path; ignored). */
  parentFolderId?: string;
}

export interface BridgeRenameParams {
  projectId: string;
  entityId: string;
  newPath: string;
  entityType?: 'doc' | 'file' | 'folder';
}

export interface BridgeMoveParams {
  projectId: string;
  entityId: string;
  targetFolderId: string;
  entityType?: 'doc' | 'file' | 'folder';
}

export interface BridgeDeleteParams {
  projectId: string;
  entityId: string;
  entityType?: 'doc' | 'file' | 'folder';
}

// ====== File-tree change event ======

export interface BridgeTreeChangeEvent {
  projectId: string;
  action: 'created' | 'renamed' | 'moved' | 'deleted';
  entityType: 'file' | 'folder';
  entityId?: string;
  filePath: string;
}

// ====== Remote content update event ======

export interface BridgeRemotePatchEvent {
  projectId: string;
  fileId: string;
  filePath: string;
  content: string;
  version: number;
}

// ====== Op submission ======

export interface BridgeSubmitOpsParams {
  projectId: string;
  fileId: string;
  version: number;
  ops: unknown[];
}

export interface BridgeSubmitOpsResult {
  version: number;
}

// ====== Core contract ======

/**
 * Minimum stable contract for a remote-project bridge. Methods are grouped as:
 * - connection management
 * - project snapshot
 * - document session
 * - op submission
 * - file-tree operations
 * - events
 */
export interface IRemoteProjectBridge {
  /** Backend type identifier */
  readonly backend: RemoteProjectBackend;

  // ====== Connection management ======

  connectProject(config: Record<string, unknown>): Promise<BridgeConnectionStateDTO>;
  disconnectProject(): void;

  // ====== Project snapshot ======

  getProjectSnapshot(projectId: string): Promise<BridgeProjectSnapshot | null>;

  // ====== Document session ======

  joinDocument(projectId: string, fileId: string): Promise<BridgeDocumentState>;
  leaveDocument(projectId: string, fileId: string): void;

  // ====== Op submission ======

  submitOps(params: BridgeSubmitOpsParams): Promise<BridgeSubmitOpsResult>;

  // ====== File-tree operations ======

  createFile(params: BridgeCreateFileParams): Promise<BridgeFileEntry>;
  createFolder(params: BridgeCreateFolderParams): Promise<BridgeFolderEntry>;
  renameEntity(params: BridgeRenameParams): Promise<{ success: boolean }>;
  moveEntity(params: BridgeMoveParams): Promise<{ success: boolean }>;
  deleteEntity(params: BridgeDeleteParams): Promise<{ success: boolean }>;

  // ====== Events ======

  readonly onRemotePatch: Event<BridgeRemotePatchEvent>;
  readonly onTreeChanged: Event<BridgeTreeChangeEvent>;
  readonly onConnectionChanged: Event<BridgeConnectionStateDTO>;

  // ====== Lifecycle ======

  dispose(): void;
}
