/**
 * @file OverleafFileSystemService - Overleaf remote file system interface
 * @description Wraps Overleaf remote file operations with unified file system interface
 * @depends IOverleafService
 *
 * Design principles:
 * - Single responsibility: only handles file system operations, not compilation
 * - Dependency injection: IOverleafService injected via constructor
 * - Composite operations: copyEntity is composed of read + create + write
 */

import { createLogger } from './LoggerService';
import type {
  CopyEntityResult,
  CreateDocResult,
  CreateFolderResult,
  DocWithId,
  IOverleafFileSystemService,
  OverleafEntityInfo,
  OverleafEntityType,
  UploadFileResult,
} from './interfaces/IOverleafFileSystemService';
import type { IOverleafService } from './interfaces/IOverleafService';

const logger = createLogger('OverleafFSService');

// ====== Internal Types ======

interface FolderEntity {
  _id: string;
  name: string;
  type?: string;
  docs?: Array<{ _id: string; name: string }>;
  fileRefs?: Array<{ _id: string; name: string }>;
  folders?: FolderEntity[];
}

// ====== Service Implementation ======

export class OverleafFileSystemService implements IOverleafFileSystemService {
  constructor(private overleafService: IOverleafService) {
    logger.info('OverleafFileSystemService initialized');
  }

  // ==================== Read Operations ====================

  async getDoc(projectId: string, docId: string): Promise<string | null> {
    try {
      const result = await this.overleafService.getDocViaSocket(projectId, docId);
      return result;
    } catch (error) {
      logger.error(`getDoc failed: projectId=${projectId}, docId=${docId}`, error);
      return null;
    }
  }

  async getDocByPath(projectId: string, path: string): Promise<DocWithId | null> {
    try {
      const result = await this.overleafService.getDocByPathWithId(projectId, path);
      return result;
    } catch (error) {
      logger.error(`getDocByPath failed: projectId=${projectId}, path=${path}`, error);
      return null;
    }
  }

  async downloadFile(projectId: string, fileId: string): Promise<Buffer | null> {
    try {
      const serverUrl = this.overleafService.getServerUrl();
      const cookies = this.overleafService.getCookies();

      if (!cookies) {
        logger.error('downloadFile failed: not logged in');
        return null;
      }

      const response = await fetch(`${serverUrl}/project/${projectId}/file/${fileId}`, {
        method: 'GET',
        headers: {
          Cookie: cookies,
        },
      });

      if (!response.ok) {
        logger.error(`downloadFile failed: HTTP ${response.status}`);
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error(`downloadFile failed: projectId=${projectId}, fileId=${fileId}`, error);
      return null;
    }
  }

  async listFolder(projectId: string, folderId?: string): Promise<OverleafEntityInfo[]> {
    try {
      const details = await this.overleafService.getProjectDetailsViaSocket(projectId);
      if (!details?.rootFolder?.[0]) {
        return [];
      }

      const rootFolder = details.rootFolder[0] as FolderEntity;
      const targetFolder = folderId ? this.findFolderById(rootFolder, folderId) : rootFolder;

      if (!targetFolder) {
        return [];
      }

      const entities: OverleafEntityInfo[] = [];

      // Add documents
      if (targetFolder.docs) {
        for (const doc of targetFolder.docs) {
          entities.push({
            id: doc._id,
            name: doc.name,
            type: 'doc',
            path: this.buildEntityPath(rootFolder, doc._id, 'doc'),
          });
        }
      }

      // Add files
      if (targetFolder.fileRefs) {
        for (const file of targetFolder.fileRefs) {
          entities.push({
            id: file._id,
            name: file.name,
            type: 'file',
            path: this.buildEntityPath(rootFolder, file._id, 'file'),
          });
        }
      }

      // Add subfolders
      if (targetFolder.folders) {
        for (const folder of targetFolder.folders) {
          entities.push({
            id: folder._id,
            name: folder.name,
            type: 'folder',
            path: this.buildEntityPath(rootFolder, folder._id, 'folder'),
          });
        }
      }

      return entities;
    } catch (error) {
      logger.error(`listFolder failed: projectId=${projectId}, folderId=${folderId}`, error);
      return [];
    }
  }

  // ==================== Create Operations ====================

  async createDoc(
    projectId: string,
    parentFolderId: string,
    name: string,
    content?: string
  ): Promise<CreateDocResult> {
    try {
      const result = await this.overleafService.createDoc(projectId, parentFolderId, name);

      if (!result.success || !result.docId) {
        return { success: false, error: 'Failed to create document' };
      }

      // If initial content provided, write content
      if (content && content.length > 0) {
        const updateResult = await this.overleafService.updateDoc(projectId, result.docId, content);
        if (!updateResult.success) {
          logger.warn(
            `createDoc: document created but failed to write initial content: docId=${result.docId}`
          );
        }
      }

      return { success: true, docId: result.docId };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to create document';
      logger.error(`createDoc failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  async createFolder(
    projectId: string,
    parentFolderId: string,
    name: string
  ): Promise<CreateFolderResult> {
    try {
      const result = await this.overleafService.createFolder(projectId, parentFolderId, name);
      return {
        success: result.success,
        folderId: result.folderId,
        error: result.success ? undefined : 'Failed to create folder',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to create folder';
      logger.error(`createFolder failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  async uploadFile(
    projectId: string,
    parentFolderId: string,
    fileName: string,
    content: Buffer
  ): Promise<UploadFileResult> {
    try {
      const result = await this.overleafService.uploadFile(
        projectId,
        parentFolderId,
        fileName,
        content
      );
      if (!result.success) {
        logger.error(
          `uploadFile failed: projectId=${projectId}, folderId=${parentFolderId}, fileName=${fileName}, error=${result.error || 'unknown'}`
        );
      }
      return {
        success: result.success,
        fileId: result.fileId,
        error: result.error,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to upload file';
      logger.error(`uploadFile failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  // ==================== Modify Operations ====================

  async updateDoc(
    projectId: string,
    docId: string,
    content: string
  ): Promise<{ success: boolean }> {
    try {
      return await this.overleafService.updateDoc(projectId, docId, content);
    } catch (error) {
      logger.error(`updateDoc failed: projectId=${projectId}, docId=${docId}`, error);
      return { success: false };
    }
  }

  async renameEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    newName: string
  ): Promise<boolean> {
    try {
      return await this.overleafService.renameEntity(projectId, entityType, entityId, newName);
    } catch (error) {
      logger.error(`renameEntity failed: ${entityType}/${entityId} -> ${newName}`, error);
      return false;
    }
  }

  async moveEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    targetFolderId: string
  ): Promise<boolean> {
    try {
      return await this.overleafService.moveEntity(projectId, entityType, entityId, targetFolderId);
    } catch (error) {
      logger.error(
        `moveEntity failed: ${entityType}/${entityId} -> folder/${targetFolderId}`,
        error
      );
      return false;
    }
  }

  // ==================== Delete Operations ====================

  async deleteEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string
  ): Promise<boolean> {
    try {
      return await this.overleafService.deleteEntity(projectId, entityType, entityId);
    } catch (error) {
      logger.error(`deleteEntity failed: ${entityType}/${entityId}`, error);
      return false;
    }
  }

  // ==================== Copy Operations ====================

  async copyEntity(
    projectId: string,
    entityType: OverleafEntityType,
    entityId: string,
    targetFolderId: string,
    newName?: string
  ): Promise<CopyEntityResult> {
    try {
      logger.info(
        `copyEntity: ${entityType}/${entityId} -> folder/${targetFolderId}, newName=${newName || '(same)'}`
      );

      // Get project details to find entity name
      const details = await this.overleafService.getProjectDetailsViaSocket(projectId);
      if (!details?.rootFolder?.[0]) {
        return { success: false, error: 'Failed to get project details' };
      }

      const rootFolder = details.rootFolder[0] as FolderEntity;
      const entityInfo = this.findEntityById(rootFolder, entityId, entityType);

      if (!entityInfo) {
        return { success: false, error: 'Source entity not found' };
      }

      const targetName = newName || entityInfo.name;

      switch (entityType) {
        case 'doc':
          return await this.copyDoc(projectId, entityId, targetFolderId, targetName);

        case 'file':
          return await this.copyFile(projectId, entityId, targetFolderId, targetName);

        case 'folder':
          return await this.copyFolder(projectId, entityId, targetFolderId, targetName, rootFolder);

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Copy failed';
      logger.error(`copyEntity failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Copy document
   */
  private async copyDoc(
    projectId: string,
    docId: string,
    targetFolderId: string,
    newName: string
  ): Promise<CopyEntityResult> {
    // 1. Get document content
    const content = await this.getDoc(projectId, docId);
    if (content === null) {
      return { success: false, error: 'Failed to get document content' };
    }

    // 2. Create new document
    const createResult = await this.createDoc(projectId, targetFolderId, newName, content);
    if (!createResult.success) {
      return { success: false, error: createResult.error || 'Failed to create new document' };
    }

    logger.info(`copyDoc success: ${docId} -> ${createResult.docId}`);
    return { success: true, newEntityId: createResult.docId };
  }

  /**
   * Copy file (binary)
   */
  private async copyFile(
    projectId: string,
    fileId: string,
    targetFolderId: string,
    newName: string
  ): Promise<CopyEntityResult> {
    // 1. Download file content
    const content = await this.downloadFile(projectId, fileId);
    if (!content) {
      return { success: false, error: 'Failed to download file content' };
    }

    // 2. Upload to target folder
    const uploadResult = await this.uploadFile(projectId, targetFolderId, newName, content);

    if (!uploadResult.success) {
      return { success: false, error: uploadResult.error || 'Failed to upload file' };
    }

    logger.info(`copyFile success: ${fileId} -> ${uploadResult.fileId}`);
    return { success: true, newEntityId: uploadResult.fileId };
  }

  /**
   * Copy folder (recursive)
   */
  private async copyFolder(
    projectId: string,
    folderId: string,
    targetFolderId: string,
    newName: string,
    rootFolder: FolderEntity
  ): Promise<CopyEntityResult> {
    // 1. Create target folder
    const createResult = await this.createFolder(projectId, targetFolderId, newName);
    if (!createResult.success || !createResult.folderId) {
      return { success: false, error: createResult.error || 'Failed to create target folder' };
    }

    const newFolderId = createResult.folderId;

    // 2. Find source folder
    const sourceFolder = this.findFolderById(rootFolder, folderId);
    if (!sourceFolder) {
      return { success: false, error: 'Source folder not found' };
    }

    // 3. Recursively copy all children
    const errors: string[] = [];

    // Copy documents
    if (sourceFolder.docs) {
      for (const doc of sourceFolder.docs) {
        const result = await this.copyDoc(projectId, doc._id, newFolderId, doc.name);
        if (!result.success) {
          errors.push(`Failed to copy document ${doc.name}: ${result.error}`);
        }
      }
    }

    // Copy files
    if (sourceFolder.fileRefs) {
      for (const file of sourceFolder.fileRefs) {
        const result = await this.copyFile(projectId, file._id, newFolderId, file.name);
        if (!result.success) {
          errors.push(`Failed to copy file ${file.name}: ${result.error}`);
        }
      }
    }

    // Recursively copy subfolders
    if (sourceFolder.folders) {
      for (const folder of sourceFolder.folders) {
        const result = await this.copyFolder(
          projectId,
          folder._id,
          newFolderId,
          folder.name,
          rootFolder
        );
        if (!result.success) {
          errors.push(`Failed to copy folder ${folder.name}: ${result.error}`);
        }
      }
    }

    if (errors.length > 0) {
      logger.warn(`copyFolder partial failure: ${errors.join('; ')}`);
      return {
        success: true,
        newEntityId: newFolderId,
        error: `Some items failed to copy: ${errors.length} errors`,
      };
    }

    logger.info(`copyFolder success: ${folderId} -> ${newFolderId}`);
    return { success: true, newEntityId: newFolderId };
  }

  // ==================== Helper Methods ====================

  async resolvePathToEntity(projectId: string, path: string): Promise<OverleafEntityInfo | null> {
    try {
      const details = await this.overleafService.getProjectDetailsViaSocket(projectId);
      if (!details?.rootFolder?.[0]) {
        return null;
      }

      const rootFolder = details.rootFolder[0] as FolderEntity;
      return this.findEntityByPath(rootFolder, path);
    } catch (error) {
      logger.error(`resolvePathToEntity failed: ${path}`, error);
      return null;
    }
  }

  async resolveFolderIdByPath(projectId: string, folderPath: string): Promise<string | null> {
    try {
      const details = await this.overleafService.getProjectDetailsViaSocket(projectId);
      if (!details?.rootFolder?.[0]) {
        return null;
      }

      const rootFolder = details.rootFolder[0] as FolderEntity;
      const folder = this.findFolderByPath(rootFolder, folderPath);
      return folder?._id || null;
    } catch (error) {
      logger.error(`resolveFolderIdByPath failed: ${folderPath}`, error);
      return null;
    }
  }

  // ==================== Private Helper Methods ====================

  private findFolderById(folder: FolderEntity, folderId: string): FolderEntity | null {
    if (folder._id === folderId) {
      return folder;
    }

    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const found = this.findFolderById(subFolder, folderId);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  private findFolderByPath(
    folder: FolderEntity,
    path: string,
    currentPath = ''
  ): FolderEntity | null {
    if (path === '' || path === '/') {
      return folder;
    }

    const normalizedPath = path.replace(/^\//, '').replace(/\/$/, '');
    const parts = normalizedPath.split('/');

    if (folder.folders) {
      for (const subFolder of folder.folders) {
        if (subFolder.name === parts[0]) {
          if (parts.length === 1) {
            return subFolder;
          }
          return this.findFolderByPath(
            subFolder,
            parts.slice(1).join('/'),
            `${currentPath}/${subFolder.name}`
          );
        }
      }
    }

    return null;
  }

  private findEntityById(
    folder: FolderEntity,
    entityId: string,
    entityType: OverleafEntityType
  ): { name: string; type: OverleafEntityType } | null {
    if (entityType === 'folder') {
      const found = this.findFolderById(folder, entityId);
      return found ? { name: found.name, type: 'folder' } : null;
    }

    if (entityType === 'doc' && folder.docs) {
      const doc = folder.docs.find((d) => d._id === entityId);
      if (doc) {
        return { name: doc.name, type: 'doc' };
      }
    }

    if (entityType === 'file' && folder.fileRefs) {
      const file = folder.fileRefs.find((f) => f._id === entityId);
      if (file) {
        return { name: file.name, type: 'file' };
      }
    }

    // Recursively search subfolders
    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const found = this.findEntityById(subFolder, entityId, entityType);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  private findEntityByPath(
    folder: FolderEntity,
    path: string,
    currentPath = ''
  ): OverleafEntityInfo | null {
    const normalizedPath = path.replace(/^\//, '');
    const parts = normalizedPath.split('/');

    if (parts.length === 1) {
      // Search in current folder
      const name = parts[0];

      if (folder.docs) {
        const doc = folder.docs.find((d) => d.name === name);
        if (doc) {
          return { id: doc._id, name: doc.name, type: 'doc', path: normalizedPath };
        }
      }

      if (folder.fileRefs) {
        const file = folder.fileRefs.find((f) => f.name === name);
        if (file) {
          return { id: file._id, name: file.name, type: 'file', path: normalizedPath };
        }
      }

      if (folder.folders) {
        const subFolder = folder.folders.find((f) => f.name === name);
        if (subFolder) {
          return { id: subFolder._id, name: subFolder.name, type: 'folder', path: normalizedPath };
        }
      }

      return null;
    }

    // Continue searching deeper
    if (folder.folders) {
      const subFolder = folder.folders.find((f) => f.name === parts[0]);
      if (subFolder) {
        return this.findEntityByPath(
          subFolder,
          parts.slice(1).join('/'),
          `${currentPath}/${parts[0]}`
        );
      }
    }

    return null;
  }

  private buildEntityPath(
    rootFolder: FolderEntity,
    entityId: string,
    entityType: OverleafEntityType,
    currentPath = ''
  ): string {
    // Check entities in current folder
    if (entityType === 'doc' && rootFolder.docs) {
      const doc = rootFolder.docs.find((d) => d._id === entityId);
      if (doc) {
        return currentPath ? `${currentPath}/${doc.name}` : doc.name;
      }
    }

    if (entityType === 'file' && rootFolder.fileRefs) {
      const file = rootFolder.fileRefs.find((f) => f._id === entityId);
      if (file) {
        return currentPath ? `${currentPath}/${file.name}` : file.name;
      }
    }

    if (entityType === 'folder' && rootFolder._id === entityId) {
      return currentPath || rootFolder.name;
    }

    // Recursively search subfolders
    if (rootFolder.folders) {
      for (const subFolder of rootFolder.folders) {
        if (entityType === 'folder' && subFolder._id === entityId) {
          return currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
        }

        const path = this.buildEntityPath(
          subFolder,
          entityId,
          entityType,
          currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name
        );
        if (path) {
          return path;
        }
      }
    }

    return '';
  }

  // ==================== Lifecycle ====================

  dispose(): void {
    logger.info('OverleafFileSystemService disposed');
  }
}

// ====== Factory Function ======

export function createOverleafFileSystemService(
  overleafService: IOverleafService
): IOverleafFileSystemService {
  return new OverleafFileSystemService(overleafService);
}
