/**
 * @file OverleafSyncService — two-way sync between local and Overleaf on save.
 * @description Triggered after Ctrl+S:
 *   1. Pull: joinDoc fetches the latest Overleaf content.
 *   2. Three-way compare across base (last-sync snapshot), local, and remote.
 *   3. No conflict -> push via submitPatches; conflict -> notify renderer.
 * @depends StudioOverleafLiveService (WebSocket: joinDoc / submitPatches)
 */

import path from 'node:path';
import fs from 'fs-extra';
import { createLogger } from './LoggerService';
import type { StudioOverleafLiveService } from './StudioOverleafLiveService';
import {
  getEntityId,
  type FolderEntity,
  type OverleafProjectMetaService,
} from './OverleafProjectMetaService';
import { Emitter, type Event } from '../../../shared/utils';

const logger = createLogger('OverleafSyncService');

// ====== Types ======

export type SyncStatus = 'synced' | 'conflict' | 'no-change' | 'error';

export interface SyncFileResult {
  status: SyncStatus;
  /** Remote content surfaced on conflict so the user can choose a resolution. */
  remoteContent?: string;
  /** Overleaf docId created for a new file (caller should update docIdMap). */
  newDocId?: string;
  error?: string;
}

export interface SyncProgressEvent {
  filePath: string;
  status: SyncStatus;
  message?: string;
}

const TRANSIENT_CREATE_ERROR_TOKENS = [
  'fetch failed',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'socket hang up',
  'Socket error',
  'Socket connect failed',
  'Overleaf connection timeout',
  'Handshake timeout',
  'Overleaf Live configure failed',
];

function isTransientCreateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_CREATE_ERROR_TOKENS.some((token) => message.includes(token));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====== Service ======

export class OverleafSyncService {
  private readonly _onDidSyncProgress = new Emitter<SyncProgressEvent>();
  readonly onDidSyncProgress: Event<SyncProgressEvent> = this._onDidSyncProgress.event;

  constructor(
    private liveService: StudioOverleafLiveService,
    private metaService?: OverleafProjectMetaService | null
  ) {}

  private async retryTransient<T>(
    label: string,
    task: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 500
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries && isTransientCreateError(error)) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(
            `${label} transient failure, retrying in ${delay}ms (${attempt}/${maxRetries})`,
            error
          );
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Sync a single file to Overleaf.
   * @param overleafProjectId - Remote Overleaf project id.
   * @param docId - Overleaf document id.
   * @param localContent - Current local content.
   * @param baseCachePath - Path to the base-cache file (snapshot from the last sync).
   */
  async syncFile(
    overleafProjectId: string,
    docId: string,
    localContent: string,
    baseCachePath: string
  ): Promise<SyncFileResult> {
    try {
      // 1. Read the base snapshot.
      let baseContent = '';
      if (await fs.pathExists(baseCachePath)) {
        baseContent = await fs.readFile(baseCachePath, 'utf-8');
      }

      // 2. Fetch the latest remote content from Overleaf.
      const joinResult = await this.liveService.joinDoc({
        projectId: overleafProjectId,
        docId,
      });
      const remoteContent = joinResult.content;
      const remoteVersion = joinResult.version;

      // 3. Three-way compare.
      const localChanged = localContent !== baseContent;
      const remoteChanged = remoteContent !== baseContent;

      if (!localChanged && !remoteChanged) {
        // Neither side changed.
        return { status: 'no-change' };
      }

      if (localChanged && !remoteChanged) {
        // Local-only change: push to Overleaf.
        await this.pushToOverleaf(
          overleafProjectId,
          docId,
          remoteVersion,
          remoteContent,
          localContent
        );
        await fs.writeFile(baseCachePath, localContent, 'utf-8');
        logger.info(`Sync succeeded (push): docId=${docId}`);
        return { status: 'synced' };
      }

      if (!localChanged && remoteChanged) {
        // Remote-only change: refresh base and return remote content for renderer to write.
        await fs.writeFile(baseCachePath, remoteContent, 'utf-8');
        logger.info(`Sync succeeded (pull): docId=${docId}`);
        return { status: 'synced', remoteContent };
      }

      // Both sides changed.
      if (localContent === remoteContent) {
        // Contents coincidentally match.
        await fs.writeFile(baseCachePath, localContent, 'utf-8');
        return { status: 'no-change' };
      }

      // Genuine conflict.
      logger.warn(`Conflict detected: docId=${docId}`);
      return { status: 'conflict', remoteContent };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Sync failed: docId=${docId}, ${msg}`);
      return { status: 'error', error: msg };
    }
  }

  /**
   * Sync to Overleaf by relative file path.
   * - docIdMap hit -> syncFile directly.
   * - Otherwise -> resolve docId via metaService by path.
   * - Missing on Overleaf as well -> create a new document.
   * @returns A SyncFileResult; newDocId is populated when a document was created so the
   *   caller can update docIdMap.
   */
  async syncFileByPath(
    overleafProjectId: string,
    relativePath: string,
    localContent: string,
    localRoot: string,
    docIdMap: Record<string, string>
  ): Promise<SyncFileResult> {
    const cacheKey = relativePath.replace(/[\\/]/g, '_');
    const baseCachePath = path.join(localRoot, '.overleaf', 'base-cache', cacheKey);

    // 1. Consult docIdMap first.
    let docId = docIdMap[relativePath];

    // 2. Miss -> resolve via metaService by path.
    if (!docId && this.metaService) {
      try {
        const found = await this.metaService.getDocByPathWithId(overleafProjectId, relativePath);
        if (found?.docId) {
          docId = found.docId;
          logger.info(`Resolved docId by path: ${relativePath} -> ${docId}`);
        }
      } catch (err) {
        logger.warn(`metaService lookup failed: ${relativePath}`, err);
      }
    }

    // 3. Still missing -> does not exist on Overleaf, create it.
    if (!docId) {
      const result = await this.createNewDocOnOverleaf(
        overleafProjectId,
        relativePath,
        localContent,
        baseCachePath
      );
      if (result) {
        return { status: 'synced', newDocId: result.docId };
      }
      return { status: 'error', error: `Failed to create new doc on Overleaf: ${relativePath}` };
    }

    // 4. Have docId -> normal three-way sync.
    const result = await this.syncFile(overleafProjectId, docId, localContent, baseCachePath);
    // Return a freshly discovered docId to the caller so they can update the map.
    if (!docIdMap[relativePath]) {
      result.newDocId = docId;
    }
    return result;
  }

  /**
   * Batch-sync all modified files within a project.
   * @param overleafProjectId - Remote Overleaf project id.
   * @param docIdMap - Local relative path -> Overleaf docId.
   * @param localRoot - Local project root path.
   */
  async syncProject(
    overleafProjectId: string,
    docIdMap: Record<string, string>,
    localRoot: string
  ): Promise<Map<string, SyncFileResult>> {
    const results = new Map<string, SyncFileResult>();
    const baseCacheDir = path.join(localRoot, '.overleaf', 'base-cache');
    await fs.ensureDir(baseCacheDir);

    for (const [filePath, docId] of Object.entries(docIdMap)) {
      const absolutePath = path.join(localRoot, filePath);
      if (!(await fs.pathExists(absolutePath))) {
        logger.warn(`Skipping missing file: ${filePath}`);
        continue;
      }

      const localContent = await fs.readFile(absolutePath, 'utf-8');
      const cacheKey = filePath.replace(/[\\/]/g, '_');
      const baseCachePath = path.join(baseCacheDir, cacheKey);

      const result = await this.syncFile(overleafProjectId, docId, localContent, baseCachePath);
      results.set(filePath, result);

      this._onDidSyncProgress.fire({
        filePath,
        status: result.status,
        message: result.error,
      });

      // If remote updated without conflict, write the remote content back to disk.
      if (result.status === 'synced' && result.remoteContent !== undefined) {
        await fs.writeFile(absolutePath, result.remoteContent, 'utf-8');
      }
    }

    return results;
  }

  /**
   * Create a new document on Overleaf and push content. Used on first sync after a local
   * file is created.
   * @returns The new Overleaf docId, or null on failure.
   */
  async createAndSyncNewFile(
    overleafProjectId: string,
    fileName: string,
    parentFolderId: string,
    localContent: string,
    baseCachePath: string
  ): Promise<{ docId: string } | null> {
    try {
      // Create the document on Overleaf.
      const createResult = await this.liveService.createEntity({
        projectId: overleafProjectId,
        entityType: 'doc',
        parentFolderId,
        name: fileName,
      });

      if (!createResult.success || !createResult.entityId) {
        logger.error(`Overleaf createDoc failed: ${fileName}`);
        return null;
      }

      const docId = createResult.entityId;

      // Write initial content if non-empty.
      if (localContent.length > 0) {
        try {
          // joinDoc to obtain the initial version.
          const joinResult = await this.liveService.joinDoc({
            projectId: overleafProjectId,
            docId,
          });
          // Replace content.
          await this.pushToOverleaf(
            overleafProjectId,
            docId,
            joinResult.version,
            joinResult.content,
            localContent
          );
        } catch (err) {
          logger.warn(`createAndSync: content write failed after document creation: ${err}`);
        }
      }

      // Write base-cache.
      await fs.ensureDir(path.dirname(baseCachePath));
      await fs.writeFile(baseCachePath, localContent, 'utf-8');

      logger.info(`New file synced to Overleaf: ${fileName} -> docId=${docId}`);
      return { docId };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`createAndSyncNewFile failed: ${fileName}, ${msg}`);
      return null;
    }
  }

  dispose(): void {
    this._onDidSyncProgress.dispose();
  }

  // ====== Private ======

  /**
   * Create a new document on Overleaf, auto-creating missing parent folders along the path.
   * @returns { docId } on success, null on failure.
   */
  private async createNewDocOnOverleaf(
    projectId: string,
    relativePath: string,
    localContent: string,
    baseCachePath: string
  ): Promise<{ docId: string } | null> {
    try {
      const parts = relativePath.split('/');
      const fileName = parts.pop()!;

      // Resolve or create the chain of parent folders.
      const parentFolderId = await this.resolveOrCreateFolderChain(projectId, parts);

      // Create the document.
      let docId: string | null = null;
      try {
        const createResult = await this.retryTransient(
          `Create Overleaf doc: ${relativePath}`,
          async () =>
            await this.liveService.createEntity({
              projectId,
              entityType: 'doc',
              parentFolderId,
              name: fileName,
            })
        );
        if (createResult.success && createResult.entityId) {
          docId = createResult.entityId;
          this.metaService?.invalidateProjectCache(projectId);
        }
      } catch (error) {
        logger.warn(
          `Failed to create Overleaf doc, attempting path-based recovery: ${relativePath}`,
          error
        );
      }

      if (!docId && this.metaService) {
        this.metaService.invalidateProjectCache(projectId);
        const recovered = await this.metaService.getDocByPathWithId(projectId, relativePath);
        if (recovered?.docId) {
          docId = recovered.docId;
          logger.warn(`Recovered new doc from remote state: ${relativePath} -> docId=${docId}`);
        }
      }

      if (!docId) {
        logger.error(`Failed to create Overleaf doc: ${relativePath}`);
        return null;
      }

      // Push initial content.
      if (localContent.length > 0) {
        try {
          const joinResult = await this.liveService.joinDoc({ projectId, docId });
          await this.pushToOverleaf(
            projectId,
            docId,
            joinResult.version,
            joinResult.content,
            localContent
          );
        } catch (err) {
          logger.warn(`Initial content write failed after document creation: ${err}`);
        }
      }

      // Refresh base-cache.
      await fs.ensureDir(path.dirname(baseCachePath));
      await fs.writeFile(baseCachePath, localContent, 'utf-8');

      logger.info(`New file synced to Overleaf: ${relativePath} -> docId=${docId}`);
      return { docId };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`createNewDocOnOverleaf failed: ${relativePath}, ${msg}`);
      return null;
    }
  }

  /** Walk each segment, resolving or creating Overleaf folders, and return the leaf id. */
  private async resolveOrCreateFolderChain(
    projectId: string,
    folderParts: string[]
  ): Promise<string> {
    const rootFolder = await this.loadProjectRootFolder(projectId);
    if (!rootFolder) {
      throw new Error(`Failed to load Overleaf project tree: ${projectId}`);
    }
    if (folderParts.length === 0) {
      return getEntityId(rootFolder);
    }

    let currentFolder: FolderEntity = rootFolder;

    for (let index = 0; index < folderParts.length; index += 1) {
      const part = folderParts[index];
      const currentPath = folderParts.slice(0, index + 1).join('/');
      const existing = (currentFolder.folders || []).find((f) => f.name === part);
      if (existing) {
        currentFolder = existing;
      } else {
        let createdFolderId: string | null = null;
        try {
          const createResult = await this.retryTransient(
            `Create Overleaf folder: ${currentPath}`,
            async () =>
              await this.liveService.createEntity({
                projectId,
                entityType: 'folder',
                parentFolderId: getEntityId(currentFolder),
                name: part,
              })
          );
          if (createResult.success && createResult.entityId) {
            createdFolderId = createResult.entityId;
            this.metaService?.invalidateProjectCache(projectId);
          }
        } catch (error) {
          logger.warn(
            `Failed to create Overleaf folder, attempting path-based recovery: ${currentPath}`,
            error
          );
        }

        if (!createdFolderId) {
          const recovered = await this.findFolderByPath(projectId, folderParts.slice(0, index + 1));
          if (recovered) {
            currentFolder = recovered;
            logger.warn(
              `Recovered folder from remote state: ${currentPath} -> folderId=${getEntityId(recovered)}`
            );
            continue;
          }
          throw new Error(`Failed to create Overleaf folder: ${currentPath}`);
        }
        currentFolder = {
          _id: createdFolderId,
          id: createdFolderId,
          name: part,
          type: 'folder',
          docs: [],
          fileRefs: [],
          folders: [],
        };
      }
    }

    return getEntityId(currentFolder);
  }

  private async loadProjectRootFolder(projectId: string): Promise<FolderEntity | null> {
    if (this.metaService) {
      const details = await this.metaService.getProjectDetailsCached(projectId);
      if (details?.rootFolder?.[0]) {
        return details.rootFolder[0];
      }
    }

    const snapshot = await this.liveService.getProjectSnapshot(projectId);
    return (snapshot?.project as { rootFolder?: FolderEntity[] })?.rootFolder?.[0] ?? null;
  }

  private async findFolderByPath(
    projectId: string,
    folderParts: string[]
  ): Promise<FolderEntity | null> {
    this.metaService?.invalidateProjectCache(projectId);
    const rootFolder = await this.loadProjectRootFolder(projectId);
    if (!rootFolder) return null;

    let currentFolder: FolderEntity = rootFolder;
    for (const part of folderParts) {
      const nextFolder = (currentFolder.folders || []).find((folder) => folder.name === part);
      if (!nextFolder) return null;
      currentFolder = nextFolder;
    }
    return currentFolder;
  }

  /** Push local content to Overleaf via a full replacement patch. */
  private async pushToOverleaf(
    projectId: string,
    docId: string,
    baseVersion: number,
    oldContent: string,
    newContent: string
  ): Promise<void> {
    // Build an offset patch that replaces the entire document.
    const patches = [
      {
        offset: 0,
        deleteCount: oldContent.length,
        insertText: newContent,
      },
    ];

    await this.liveService.submitPatches({
      projectId,
      docId,
      baseVersion,
      patches,
    });
  }
}
