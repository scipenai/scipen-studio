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

// ====== Agent Services ======
export type {
  IAgentService,
  AgentResult,
  AgentResultData,
  AgentExecutionOptions,
  Pdf2LatexConfig,
  Paper2BeamerConfig,
} from './IAgentService';

// ====== Knowledge Services ======
export type {
  IKnowledgeService,
  InitOptions,
} from './IKnowledgeService';

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
export type {
  IOverleafService,
  OverleafConfig,
  OverleafProject,
  OverleafProjectDetails,
  OverleafProjectSettings,
  OverleafCompileOptions,
  OverleafCompileResult,
  OverleafSyncCodePos,
  OverleafSyncPdfPos,
  OverleafSocketEventHandlers,
} from './IOverleafService';

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

// ====== Local Replica Services ======
export type {
  ILocalReplicaService,
  LocalReplicaConfig,
  SyncResult,
  SyncProgressEvent,
  ConflictInfo,
} from './ILocalReplicaService';
export { DEFAULT_IGNORE_PATTERNS } from './ILocalReplicaService';

// ====== Selection Helper Services ======
export type {
  ISelectionService,
  SelectionCaptureData,
  SelectionConfig,
} from './ISelectionService';

// ====== Configuration ======
export type { IConfigManager } from './IConfigManager';
