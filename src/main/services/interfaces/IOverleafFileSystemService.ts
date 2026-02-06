/**
 * @file IOverleafFileSystemService - Overleaf file system contract
 * @description Remote file operations separated from compile-related services
 * @depends IOverleafService
 */

import type { IDisposable } from '../ServiceContainer';

// ====== Type Definitions ======

/** Overleaf entity type. */
export type OverleafEntityType = 'doc' | 'file' | 'folder';

/** Overleaf entity info. */
export interface OverleafEntityInfo {
  id: string;
  name: string;
  type: OverleafEntityType;
  path: string;
}

/** Copy operation result. */
export interface CopyEntityResult {
  success: boolean;
  newEntityId?: string;
  error?: string;
}

/** Create document result. */
export interface CreateDocResult {
  success: boolean;
  docId?: string;
  error?: string;
}

/** Create folder result. */
export interface CreateFolderResult {
  success: boolean;
  folderId?: string;
  error?: string;
}

/** Upload file result. */
export interface UploadFileResult {
  success: boolean;
  fileId?: string;
  error?: string;
}

/** Document content with id. */
export interface DocWithId {
  content: string;
  docId: string;
}

// ====== Service Interface ======

/**
 * Overleaf file system interface.
 */
export interface IOverleafFileSystemService extends IDisposable {
  // ====== Read Operations ======

  /**
   * Fetches document content.
   * @param projectId Project id
   * @param docId Document id
   * @returns Document content or null on failure
   */
  getDoc(projectId: string, docId: string): Promise<string | null>;

  /**
   * Fetches document content by path.
   * @param projectId Project id
   * @param path Document path (relative to project root)
   * @returns Document content + id or null on failure
   */
  getDocByPath(projectId: string, path: string): Promise<DocWithId | null>;

  /**
   * Downloads a binary file.
   * @param projectId Project id
   * @param fileId File id
   * @returns File content or null on failure
   */
  downloadFile(projectId: string, fileId: string): Promise<Buffer | null>;

  /**
   * Lists folder contents.
   * @param projectId Project id
   * @param folderId Folder id (omit for root)
   * @returns Entity info list
   */
  listFolder(projectId: string, folderId?: string): Promise<OverleafEntityInfo[]>;

  // ====== Create Operations ======

  /**
   * Creates a document.
   * @param projectId Project id
   * @param parentFolderId Parent folder id
   * @param name File name
   * @param content Initial content (optional)
   */
  createDoc(
    projectId: string,
    parentFolderId: string,
    name: string,
    content?: string
  ): Promise<CreateDocResult>;

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
  ): Promise<CreateFolderResult>;

  /**
   * Uploads a binary file.
   * @param projectId Project id
   * @param parentFolderId Parent folder id
   * @param fileName File name
   * @param content File content
   */
  uploadFile(
    projectId: string,
    parentFolderId: string,
    fileName: string,
    content: Buffer
  ): Promise<UploadFileResult>;

  // ====== Update Operations ======

  /**
   * Updates document content.
   * @param projectId Project id
   * @param docId Document id
   * @param content New content
   */
  updateDoc(projectId: string, docId: string, content: string): Promise<{ success: boolean }>;

  /**
   * Renames an entity.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   * @param newName New name
   */
  renameEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    newName: string
  ): Promise<boolean>;

  /**
   * Moves an entity to a target folder.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   * @param targetFolderId Target folder id
   */
  moveEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    targetFolderId: string
  ): Promise<boolean>;

  // ====== Delete Operations ======

  /**
   * Deletes an entity.
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   */
  deleteEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string
  ): Promise<boolean>;

  // ====== Copy Operations ======

  /**
   * Copies an entity to a target folder.
   *
   * Composite operation: read + create + write
   * - doc: getDoc -> createDoc -> updateDoc
   * - file: downloadFile -> uploadFile
   * - folder: recursively copy all children
   *
   * @param projectId Project id
   * @param entityType Entity type
   * @param entityId Entity id
   * @param targetFolderId Target folder id
   * @param newName Optional new name (defaults to original)
   */
  copyEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    targetFolderId: string,
    newName?: string
  ): Promise<CopyEntityResult>;

  // ====== Helpers ======

  /**
   * Resolves entity info by path.
   * @param projectId Project id
   * @param path Entity path
   */
  resolvePathToEntity(projectId: string, path: string): Promise<OverleafEntityInfo | null>;

  /**
   * Resolves folder id by path.
   * @param projectId Project id
   * @param folderPath Folder path
   */
  resolveFolderIdByPath(projectId: string, folderPath: string): Promise<string | null>;
}
