/**
 * @file interfaces/index - Service interface entrypoint
 * @description Re-exports service contracts for dependency injection
 * @depends ServiceContainer
 */

// ====== AI Services ======
export type {
  IAIService,
  AIConfig,
  AIMessage,
  StreamChunk,
} from './IAIService';

// ====== File System Services ======
export type {
  IFileSystemService,
  FileNode,
  FileChangeEvent,
} from './IFileSystemService';

// ====== SyncTeX Services ======
export type {
  ISyncTeXService,
  ForwardSyncResult,
  InverseSyncResult,
} from './ISyncTeXService';

// ====== Compiler Registry ======
export type { ICompilerRegistry } from './ICompilerRegistry';

// ====== Overleaf Services ======
// Types are imported from their individual service files.

// ====== Overleaf File System Services ======
export type {
  IOverleafFileSystemService,
  OverleafEntityType,
  OverleafEntityInfo,
  CopyEntityResult,
  CreateDocResult,
  CreateFolderResult,
  UploadFileResult,
  DocWithId,
} from './IOverleafFileSystemService';

// ====== Selection Helper Services ======
export type {
  ISelectionService,
  SelectionCaptureData,
  SelectionConfig,
} from './ISelectionService';

// ====== Project Binding Services ======
export type { IProjectBindingService } from './IProjectBindingService';
export {
  OT_MANAGED_EXTENSIONS,
  RESOURCE_EXTENSIONS,
  ALWAYS_IGNORE_DIRS,
} from './IProjectBindingService';

// ====== Remote Project Bridge ======
export type {
  IRemoteProjectBridge,
  BridgeConnectionState,
  BridgeConnectionStateDTO,
  BridgeProjectSnapshot,
  BridgeFileEntry,
  BridgeFolderEntry,
  BridgeDocumentState,
  BridgeRemotePatchEvent,
  BridgeTreeChangeEvent,
  BridgeSubmitOpsParams,
  BridgeSubmitOpsResult,
  BridgeCreateFileParams,
  BridgeCreateFolderParams,
  BridgeRenameParams,
  BridgeMoveParams,
  BridgeDeleteParams,
} from './IRemoteProjectBridge';

// ====== Configuration ======
export type { IConfigManager } from './IConfigManager';
