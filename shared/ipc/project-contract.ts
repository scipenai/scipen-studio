/**
 * @file Project Binding / Workspace / External Change IPC Contract
 * @description Project binding, workspace, maintenance, external change types and channel contract
 * @depends ipc/channels
 */

import { IpcChannel } from './channels';

// ====== Web Workspace Types ======

export type WorkspaceEntryType = 'file' | 'directory';
export type WorkspaceFileKind = 'text' | 'binary';

export interface WorkspaceTreeNodeDTO {
  id: string;
  name: string;
  path: string;
  type: WorkspaceEntryType;
  kind?: WorkspaceFileKind;
  editable?: boolean;
  language?: string | null;
  projectId?: string;
  fileId?: string;
  folderId?: string;
  children?: WorkspaceTreeNodeDTO[];
}

export interface WorkspaceBootstrapDTO {
  projectId: string;
  workspaceId: string;
  rootPath: string;
  name: string;
  conversationId: string | null;
  botUserId: string | null;
  tree: WorkspaceTreeNodeDTO;
}

export interface WorkspaceFileDTO {
  projectId: string;
  fileId: string;
  path: string;
  title: string;
  content: string;
  version: number;
  kind: 'text';
  language?: string | null;
}

export interface WorkspaceCreateFileParams {
  path: string;
  content?: string;
}

export interface WorkspaceCreateFolderParams {
  path: string;
}

export interface WorkspaceRenameEntryParams {
  entryType: WorkspaceEntryType;
  path: string;
  newPath: string;
}

export interface WorkspaceUploadFileParams {
  targetPath: string;
  files: Array<{
    name: string;
    mimeType?: string;
    dataBase64: string;
  }>;
}

export interface WorkspaceMutationResultDTO {
  tree: WorkspaceTreeNodeDTO;
  file?: WorkspaceFileDTO;
  uploadedNames?: string[];
  errors?: string[];
}

export type WorkspaceBuildState = 'queued' | 'running' | 'completed' | 'failed';

export interface WorkspaceCompileParams {
  path: string;
  engine?: 'pdflatex' | 'xelatex' | 'lualatex' | 'typst';
}

export interface WorkspaceBuildLogEntryDTO {
  file?: string;
  line?: number | null;
  level: 'error' | 'warning' | 'info';
  message: string;
  raw?: string;
}

export interface WorkspaceBuildDTO {
  buildId: string;
  state: WorkspaceBuildState;
  path: string;
  engine?: string;
  success: boolean;
  createdAt: number;
  finishedAt?: number;
  pdfUrl?: string;
  logUrl?: string;
  log?: string;
  errors: string[];
  warnings: string[];
  parsedErrors?: WorkspaceBuildLogEntryDTO[];
  parsedWarnings?: WorkspaceBuildLogEntryDTO[];
}

// ====== Project Binding Types ======

/** Project binding status: unmanaged / bound / syncing / error. */
export type ProjectBindingStatus = 'unbound' | 'bound' | 'syncing' | 'error';
export type RemoteProjectBackend = 'scipen-ot' | 'overleaf';
export type RemoteProjectAuthority = 'remote';
export type RemoteProjectMaterialization = 'local-working-copy';

/** Content format of the local marker file .scipen/project.json. */
export interface ScipenProjectMarker {
  /** Marker file schema version, used for future format migrations. */
  schemaVersion: number;
  projectId: string;
  workspaceId: string;
  backend?: RemoteProjectBackend;
  authority?: RemoteProjectAuthority;
  materialization?: RemoteProjectMaterialization;
  createdAt: string;
}

/** Project binding DTO returned to the renderer. */
export interface ProjectBindingDTO {
  id: string;
  projectId: string;
  remoteProjectId: string;
  workspaceId: string;
  backend: RemoteProjectBackend;
  authority: RemoteProjectAuthority;
  materialization: RemoteProjectMaterialization;
  localRootPath: string;
  projectName: string;
  enabled: boolean;
  lastSyncAt: number | null;
  status: ProjectBindingStatus;
}

/** Params for importing a directory as a collaborative project. */
export interface ImportProjectParams {
  /** Absolute path of the local directory. */
  localRootPath: string;
  /** Display name; defaults to the directory name. */
  projectName?: string;
  /** Custom ignore patterns. */
  customIgnorePatterns?: string[];
}

/** Result of a project import. */
export interface ImportProjectResult {
  binding: ProjectBindingDTO;
  /** Number of OT text files imported. */
  textFilesImported: number;
  /** Number of resource (binary) files imported. */
  resourceFilesImported: number;
  /** Number of files skipped by ignore rules. */
  skippedFiles: number;
}

/** Result of resolving the binding for a local directory. */
export interface ResolveBindingResult {
  /** Whether a valid binding was found. */
  found: boolean;
  /** Binding info, if found. */
  binding: ProjectBindingDTO | null;
  /** Where the binding was resolved from. */
  source: 'database' | 'marker_file' | 'none';
}

/** Params for persisting a binding after a successful bootstrap sync. */
export interface EnsureBindingFromBootstrapParams {
  localRootPath: string;
  remoteProjectId: string;
  projectName?: string;
  backend?: RemoteProjectBackend;
}

export interface EnsureBindingFromBootstrapResult {
  created: boolean;
  recovered: boolean;
  binding: ProjectBindingDTO;
}

/** Event fired when a project binding's status changes. */
export interface ProjectBindingStatusEvent {
  projectId: string;
  localRootPath: string;
  status: ProjectBindingStatus;
  message?: string;
}

// ====== Maintenance Operations ======

/** Rebuild: fully rebuild the local working copy from the remote. */
export interface RebuildWorkingCopyParams {
  /** Root path of the local project. */
  localRootPath: string;
}

export interface RebuildWorkingCopyResult {
  success: boolean;
  filesWritten: number;
  foldersCreated: number;
  errors: string[];
}

/** Rebind: point a local directory at an existing remote project. */
export interface RebindProjectParams {
  /** Absolute path of the local directory. */
  localRootPath: string;
  /** Target remote project ID. */
  remoteProjectId: string;
  /** Backend type. */
  backend?: RemoteProjectBackend;
}

export interface RebindProjectResult {
  success: boolean;
  binding: ProjectBindingDTO | null;
}

/** Export: snapshot a remote project to disk. */
export interface ExportSnapshotParams {
  /** Remote project ID. */
  remoteProjectId: string;
  /** Destination directory for the export. */
  exportPath: string;
}

export interface ExportSnapshotResult {
  success: boolean;
  filesExported: number;
  exportPath: string;
  errors: string[];
}

// ====== External Change Detection ======

/** Info for a single externally-changed file. */
export interface ExternalChangeFileDTO {
  relativePath: string;
  absolutePath: string;
  changeType: 'modified' | 'created' | 'deleted';
  fileSize: number;
  /** Sync status classified by ExternalChangeDetector. */
  syncStatus?: 'SYNCED' | 'CONFLICT' | 'NEW' | 'DELETED';
}

/** Batch of external changes pushed from main to renderer. */
export interface ExternalChangeBatchDTO {
  batchId: string;
  /** Cloud project ID, usable directly for conflict resolution without a path lookup. */
  projectId: string | null;
  projectRootPath: string;
  files: ExternalChangeFileDTO[];
  isBulk: boolean;
  detectedAt: number;
}

/** User's conflict-resolution choice. */
export type ConflictResolutionChoice = 'keep_cloud' | 'skip';

/** Conflict-resolution request from renderer to main. */
export interface ResolveExternalChangeParams {
  batchId: string;
  /** Project root path, used to locate the binding and snapshot. */
  projectRootPath: string;
  resolutions: Array<{
    relativePath: string;
    choice: ConflictResolutionChoice;
  }>;
}

/** Auto-resolution notification from main to renderer. */
export interface ExternalChangeAutoResolvedDTO {
  projectId: string;
  /** Files that were auto-overwritten by cloud content. */
  resolvedFiles: Array<{
    relativePath: string;
    action: 'cloud_overwrite' | 'local_deleted';
  }>;
  /** When the resolution occurred. */
  resolvedAt: number;
}

// ====== Channel Contract ======

export interface IPCProjectContract {
  // ============ Project Binding ============
  [IpcChannel.ProjectBinding_Import]: {
    args: [params: ImportProjectParams];
    result: ImportProjectResult;
  };
  [IpcChannel.ProjectBinding_Unbind]: {
    args: [projectId: string];
    result: { success: boolean };
  };
  [IpcChannel.ProjectBinding_GetByPath]: {
    args: [localRootPath: string];
    result: ProjectBindingDTO | null;
  };
  [IpcChannel.ProjectBinding_GetByProjectId]: {
    args: [projectId: string];
    result: ProjectBindingDTO | null;
  };
  [IpcChannel.ProjectBinding_Resolve]: {
    args: [localRootPath: string];
    result: ResolveBindingResult;
  };
  [IpcChannel.ProjectBinding_EnsureBootstrap]: {
    args: [params: EnsureBindingFromBootstrapParams];
    result: EnsureBindingFromBootstrapResult;
  };
  [IpcChannel.ProjectBinding_SetEnabled]: {
    args: [projectId: string, enabled: boolean];
    result: { success: boolean };
  };

  // ============ External Change Detection ============
  [IpcChannel.ExternalChange_Resolve]: {
    args: [params: ResolveExternalChangeParams];
    result: { success: boolean; resolved: number; failed: number; errors: string[] };
  };

  // ============ Maintenance ============
  [IpcChannel.ProjectBinding_Rebuild]: {
    args: [params: RebuildWorkingCopyParams];
    result: RebuildWorkingCopyResult;
  };
  [IpcChannel.ProjectBinding_Rebind]: {
    args: [params: RebindProjectParams];
    result: RebindProjectResult;
  };
  [IpcChannel.ProjectBinding_ExportSnapshot]: {
    args: [params: ExportSnapshotParams];
    result: ExportSnapshotResult;
  };
}
