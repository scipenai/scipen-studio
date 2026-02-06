/**
 * @file IOverleafService - Overleaf service contract
 * @description Domain model interface for main-process Overleaf operations
 * @depends OverleafCompiler
 * @note IPC uses DTOs mapped from domain models; dates are converted to ISO strings
 */

// ====== Domain Models ======

/**
 * Overleaf config (domain model).
 */
export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
}

/**
 * Overleaf project (domain model).
 * Uses Date for main-process business logic convenience.
 */
export interface OverleafProject {
  id: string;
  name: string;
  lastUpdated?: Date;
  accessLevel?: string;
}

/**
 * Overleaf project details (domain model).
 */
export interface OverleafProjectDetails {
  name?: string;
  rootFolder?: unknown[];
  compiler?: string;
  rootDoc_id?: string;
}

/**
 * Overleaf project settings.
 */
export interface OverleafProjectSettings {
  compiler?: string;
  rootDocId?: string;
}

/**
 * Overleaf compile options (domain model).
 */
export interface OverleafCompileOptions {
  compiler?: string;
  draft?: boolean;
  stopOnFirstError?: boolean;
  rootDocId?: string;
}

/**
 * Parsed log entry (domain model).
 */
export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

/**
 * Overleaf compile result (domain model).
 */
export interface OverleafCompileResult {
  success: boolean;
  status: string;
  pdfData?: string;
  pdfUrl?: string;
  logUrl?: string;
  logContent?: string;
  buildId?: string;
  errors?: string[];
  parsedErrors?: ParsedLogEntry[];
  parsedWarnings?: ParsedLogEntry[];
  parsedInfo?: ParsedLogEntry[];
}

/**
 * SyncTeX position (code -> PDF).
 */
export interface OverleafSyncCodePos {
  page: number;
  h: number;
  v: number;
  width?: number;
  height?: number;
}

/**
 * SyncTeX position (PDF -> code).
 */
export interface OverleafSyncPdfPos {
  file: string;
  line: number;
  column: number;
}

/**
 * File entity for file operations.
 */
export interface FileEntity {
  _id: string;
  id?: string;
  name: string;
  path?: string;
  type?: 'doc' | 'file' | 'folder';
  docs?: FileEntity[];
  folders?: FileEntity[];
  fileRefs?: FileEntity[];
}

// ====== Service Interface ======

/**
 * Overleaf service interface.
 * All methods return domain models; IPC handlers convert them to DTOs.
 */
export interface IOverleafService {
  /**
   * Tests connectivity to the Overleaf server.
   */
  testConnection(): Promise<{ success: boolean; message: string }>;

  /**
   * Logs in to Overleaf.
   */
  login(): Promise<{ success: boolean; error?: string }>;

  /**
   * Checks whether login is active.
   */
  isLoggedIn(): boolean;

  /**
   * Returns current cookies.
   */
  getCookies(): string | null;

  /**
   * Returns server URL.
   */
  getServerUrl(): string;

  /**
   * Returns project list.
   */
  getProjects(): Promise<OverleafProject[]>;

  /**
   * Returns project details.
   * @param projectId Project id
   */
  getProjectDetails(projectId: string): Promise<OverleafProjectDetails | null>;

  /**
   * Returns project details via Socket.
   * @param projectId Project id
   */
  getProjectDetailsViaSocket(projectId: string): Promise<OverleafProjectDetails | null>;

  /**
   * Updates project settings.
   * @param projectId Project id
   * @param settings Settings payload
   */
  updateProjectSettings(projectId: string, settings: OverleafProjectSettings): Promise<boolean>;

  /**
   * Compiles a project.
   * @param projectId Project id
   * @param options Compile options
   */
  compile(projectId: string, options?: OverleafCompileOptions): Promise<OverleafCompileResult>;

  /**
   * Stops compilation.
   * @param projectId Project id
   */
  stopCompile(projectId: string): Promise<boolean>;

  /**
   * Returns latest buildId.
   */
  getLastBuildId(): string | null;

  /**
   * Downloads PDF.
   * @param url Full PDF URL (from compile.pdfUrl)
   */
  downloadPdf(url: string): Promise<ArrayBuffer | null>;

  /**
   * Downloads compile log.
   * @param url Full log URL (from compile.logUrl)
   */
  downloadLog(url: string): Promise<string | null>;

  /**
   * Forward sync (code -> PDF).
   * @param projectId Project id
   * @param file File path
   * @param line Line number
   * @param column Column number
   * @param buildId Build id
   */
  syncCode(
    projectId: string,
    file: string,
    line: number,
    column: number,
    buildId?: string
  ): Promise<OverleafSyncCodePos[] | null>;

  /**
   * Inverse sync (PDF -> code).
   * @param projectId Project id
   * @param page Page number
   * @param h Horizontal position
   * @param v Vertical position
   * @param buildId Build id
   */
  syncPdf(
    projectId: string,
    page: number,
    h: number,
    v: number,
    buildId?: string
  ): Promise<OverleafSyncPdfPos | null>;

  /**
   * Fetches document content.
   * @param projectId Project id
   * @param docIdOrPath Document id or path
   * @param isPath Whether docIdOrPath is a path
   */
  getDoc(
    projectId: string,
    docIdOrPath: string,
    isPath?: boolean
  ): Promise<{ success: boolean; content?: string; docId?: string; error?: string }>;

  /**
   * Fetches document by path and returns docId.
   * @param projectId Project id
   * @param filePath File path
   */
  getDocByPathWithId(
    projectId: string,
    filePath: string
  ): Promise<{ content: string; docId: string } | null>;

  /**
   * Fetches document via socket.
   * @param projectId Project id
   * @param docId Document id
   */
  getDocViaSocket(projectId: string, docId: string): Promise<string | null>;

  /**
   * Fetches document content via HTTP.
   * @param projectId Project id
   * @param docId Document id
   */
  getDocContent(projectId: string, docId: string): Promise<string | null>;

  /**
   * Updates document content.
   * @param projectId Project id
   * @param docId Document id
   * @param content New content
   */
  updateDoc(projectId: string, docId: string, content: string): Promise<{ success: boolean }>;

  /**
   * Updates document content immediately.
   * @param projectId Project id
   * @param docId Document id
   * @param content New content
   */
  updateDocContent(
    projectId: string,
    docId: string,
    content: string
  ): Promise<{ success: boolean }>;

  /**
   * Updates document content with debounce.
   * @param projectId Project id
   * @param docId Document id
   * @param content New content
   */
  updateDocDebounced(
    projectId: string,
    docId: string,
    content: string
  ): Promise<{ success: boolean }>;

  /**
   * Flushes pending updates.
   * @param projectId Project id
   */
  flushUpdates(projectId?: string): Promise<void>;

  /**
   * Returns cached document content.
   * @param projectId Project id
   * @param docId Document id
   */
  getDocCached(projectId: string, docId: string): { content: string; version: number } | null;

  /**
   * Clears cache entries.
   * @param projectId Project id
   * @param docId Document id
   */
  clearCache(projectId?: string, docId?: string): void;

  /**
   * Creates a document.
   * @param projectId Project id
   * @param parentFolderId Parent folder id
   * @param name File name
   */
  createDoc(
    projectId: string,
    parentFolderId: string,
    name: string
  ): Promise<{ success: boolean; docId?: string }>;

  /**
   * Creates a folder.
   * @param projectId Project id
   * @param parentFolderId Parent folder id
   * @param name Folder name
   */
  createFolder(
    projectId: string,
    parentFolderId: string,
    name: string
  ): Promise<{ success: boolean; folderId?: string }>;

  /**
   * Deletes an entity.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   */
  deleteEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string
  ): Promise<boolean>;

  /**
   * Renames an entity.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   * @param newName New name
   */
  renameEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string,
    newName: string
  ): Promise<boolean>;

  /**
   * Moves an entity to target folder.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   * @param targetFolderId Target folder id
   */
  moveEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string,
    targetFolderId: string
  ): Promise<boolean>;

  /**
   * Uploads a file.
   * @param projectId Project id
   * @param folderId Target folder id
   * @param fileName File name
   * @param content File content
   */
  uploadFile(
    projectId: string,
    folderId: string,
    fileName: string,
    content: Buffer
  ): Promise<{ success: boolean; fileId?: string; error?: string }>;

  // ====== Socket Events (Local Replica Sync) ======

  /**
   * Subscribes to project socket events.
   * @param projectId Project id
   * @param handlers Event handlers
   * @returns Unsubscribe function
   */
  subscribeToProjectEvents(
    projectId: string,
    handlers: OverleafSocketEventHandlers
  ): (() => void) | null;

  /**
   * Checks whether project socket is connected.
   * @param projectId Project id
   */
  isProjectConnected(projectId: string): boolean;
}

// ====== Socket Event Handler Types ======

/**
 * Overleaf socket event handlers (used for Local Replica sync).
 */
export interface OverleafSocketEventHandlers {
  /** Document content change (OT update). */
  onDocChanged?: (docId: string, update: { op: unknown[]; v: number }) => void;
  /** Document created. */
  onDocCreated?: (parentFolderId: string, doc: { _id: string; name: string }) => void;
  /** File created. */
  onFileCreated?: (parentFolderId: string, file: { _id: string; name: string }) => void;
  /** Folder created. */
  onFolderCreated?: (parentFolderId: string, folder: { _id: string; name: string }) => void;
  /** Entity renamed. */
  onEntityRenamed?: (entityId: string, newName: string) => void;
  /** Entity moved. */
  onEntityMoved?: (entityId: string, newFolderId: string) => void;
  /** Entity removed. */
  onEntityRemoved?: (entityId: string) => void;
}
