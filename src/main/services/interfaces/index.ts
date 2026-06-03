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

// ====== Configuration ======
export type { IConfigManager } from './IConfigManager';
