/**
 * @file OverleafProjectDownloader — downloads an Overleaf remote project to local disk.
 * @description On first connect, downloads all files under
 *   ~/.scipen-studio/overleaf-projects/{projectName}/ so the project can be registered as a
 *   standard OT project via openLocalProject() later.
 * @depends StudioOverleafLiveService (project tree snapshot + doc content)
 * @depends OverleafFileSystemService (binary file download)
 * @depends OverleafProjectMetaStore (metadata I/O; pure local FS, no network dependency)
 */

import path from 'node:path';
import fs from 'fs-extra';
import { createLogger } from './LoggerService';
import type { StudioOverleafLiveService } from './StudioOverleafLiveService';
import type { IOverleafFileSystemService } from './interfaces/IOverleafFileSystemService';
import {
  OVERLEAF_PROJECTS_DIR,
  META_DIR,
  writeMeta,
  type OverleafProjectMeta,
} from './OverleafProjectMetaStore';

const logger = createLogger('OverleafProjectDownloader');

// Re-export to keep the public type surface stable.
export type { OverleafProjectMeta } from './OverleafProjectMetaStore';

// ====== Types ======

/** Overleaf folder tree node. */
interface FolderNode {
  _id: string;
  name: string;
  docs?: Array<{ _id: string; name: string }>;
  fileRefs?: Array<{ _id: string; name: string }>;
  folders?: FolderNode[];
}

/** Download result. */
export interface DownloadResult {
  localPath: string;
  /** Text files list used for OT registration. */
  files: Array<{ file_path: string; content: string }>;
  folders: string[];
  meta: OverleafProjectMeta;
}

/**
 * Full snapshot of the Overleaf tree after traversal. Separating the file listing from file
 * contents lets cleanup reason about the complete manifest rather than a partial slice.
 */
interface RemoteManifest {
  docs: Array<{ relativePath: string; content: string; docId: string }>;
  binaries: Array<{ relativePath: string }>;
  folders: string[];
  docIdMap: Record<string, string>;
}

const BASE_CACHE_DIR = 'base-cache';

// ====== Service ======

export class OverleafProjectDownloader {
  constructor(
    private liveService: StudioOverleafLiveService,
    private overleafFS: IOverleafFileSystemService
  ) {}

  /**
   * Full-sync download of an Overleaf project to local disk.
   *
   * Flow: fetch remote tree -> download all files -> prune stale entries -> write metadata
   * and base-cache.
   */
  async downloadProject(
    projectId: string,
    projectName: string,
    serverUrl: string
  ): Promise<DownloadResult> {
    const safeName = this.sanitizeProjectName(projectName);
    const localPath = path.join(OVERLEAF_PROJECTS_DIR, safeName);

    logger.info(
      `Starting Overleaf project download: ${projectName} (${projectId}) -> ${localPath}`
    );

    // 1. Fetch the remote project tree.
    const rootFolder = await this.fetchProjectTree(projectId);

    // 2. Ensure the local directory exists.
    await fs.ensureDir(localPath);

    // 3. Walk the tree and download all files.
    const manifest = await this.downloadAllFiles(projectId, rootFolder, localPath);

    // 4. Remove local entries no longer present remotely (rename/delete scenarios).
    await this.cleanupStaleEntries(localPath, manifest);

    // 5. Write metadata and base-cache.
    const meta: OverleafProjectMeta = {
      overleafProjectId: projectId,
      serverUrl,
      projectName,
      docIdMap: manifest.docIdMap,
      downloadedAt: new Date().toISOString(),
    };
    await writeMeta(localPath, meta);
    await this.writeBaseCache(localPath, manifest);

    logger.info(
      `Overleaf project download completed: ${manifest.docs.length} docs, ${manifest.binaries.length} binaries, ${manifest.folders.length} folders`
    );

    return {
      localPath,
      files: manifest.docs.map((d) => ({ file_path: d.relativePath, content: d.content })),
      folders: manifest.folders,
      meta,
    };
  }

  // ====== Private: project tree ======

  private async fetchProjectTree(projectId: string): Promise<FolderNode> {
    const snapshot = await this.liveService.getProjectSnapshot(projectId);
    if (!snapshot?.project) {
      throw new Error(`Failed to fetch project snapshot: ${projectId}`);
    }
    const project = snapshot.project as { rootFolder?: FolderNode[] };
    const rootFolder = project.rootFolder?.[0];
    if (!rootFolder) {
      throw new Error(`Project tree is empty: ${projectId}`);
    }
    return rootFolder;
  }

  // ====== Private: file download ======

  private async downloadAllFiles(
    projectId: string,
    rootFolder: FolderNode,
    localRoot: string
  ): Promise<RemoteManifest> {
    const manifest: RemoteManifest = { docs: [], binaries: [], folders: [], docIdMap: {} };
    await this.traverseFolder(projectId, rootFolder, '', localRoot, manifest);
    return manifest;
  }

  private async traverseFolder(
    projectId: string,
    folder: FolderNode,
    relativePath: string,
    localRoot: string,
    manifest: RemoteManifest
  ): Promise<void> {
    if (relativePath) {
      manifest.folders.push(relativePath);
      await fs.ensureDir(path.join(localRoot, relativePath));
    }

    for (const doc of folder.docs ?? []) {
      const filePath = relativePath ? `${relativePath}/${doc.name}` : doc.name;
      try {
        const content = await this.liveService.getDocContent(projectId, doc._id);
        if (content !== null) {
          manifest.docs.push({ relativePath: filePath, content, docId: doc._id });
          manifest.docIdMap[filePath] = doc._id;
          await fs.writeFile(path.join(localRoot, filePath), content, 'utf-8');
        } else {
          logger.warn(`Skipping doc with empty content: ${filePath}`);
        }
      } catch (error) {
        logger.error(`Failed to download doc: ${filePath}`, error);
      }
    }

    for (const fileRef of folder.fileRefs ?? []) {
      const filePath = relativePath ? `${relativePath}/${fileRef.name}` : fileRef.name;
      try {
        const buffer = await this.overleafFS.downloadFile(projectId, fileRef._id);
        if (buffer) {
          manifest.binaries.push({ relativePath: filePath });
          await fs.writeFile(path.join(localRoot, filePath), Buffer.from(buffer));
        }
      } catch (error) {
        logger.error(`Failed to download binary: ${filePath}`, error);
      }
    }

    for (const sub of folder.folders ?? []) {
      const subPath = relativePath ? `${relativePath}/${sub.name}` : sub.name;
      await this.traverseFolder(projectId, sub, subPath, localRoot, manifest);
    }
  }

  // ====== Private: cleanup ======

  /**
   * Prune local files and base-cache entries that are no longer in the remote manifest.
   * Without this, renames/deletes on Overleaf would lead to ENOENT errors and an
   * inconsistent docIdMap.
   */
  private async cleanupStaleEntries(localRoot: string, manifest: RemoteManifest): Promise<void> {
    const remoteFilePaths = new Set([
      ...manifest.docs.map((d) => d.relativePath),
      ...manifest.binaries.map((b) => b.relativePath),
    ]);
    const remoteFolderPaths = new Set(manifest.folders);

    await this.cleanupStaleBaseCache(localRoot, manifest.docs);
    await this.cleanupStaleDirectory(localRoot, '', remoteFilePaths, remoteFolderPaths);
  }

  private async cleanupStaleBaseCache(
    localRoot: string,
    remoteDocs: Array<{ relativePath: string }>
  ): Promise<void> {
    const baseCacheDir = path.join(localRoot, META_DIR, BASE_CACHE_DIR);
    if (!(await fs.pathExists(baseCacheDir))) return;

    const validCacheKeys = new Set(remoteDocs.map((d) => d.relativePath.replace(/[\\/]/g, '_')));

    const entries = await fs.readdir(baseCacheDir);
    for (const entry of entries) {
      if (!validCacheKeys.has(entry)) {
        await fs.remove(path.join(baseCacheDir, entry));
        logger.info(`Removed stale base-cache entry: ${entry}`);
      }
    }
  }

  private async cleanupStaleDirectory(
    baseDir: string,
    relativePath: string,
    remoteFiles: Set<string>,
    remoteFolders: Set<string>
  ): Promise<void> {
    const fullDir = relativePath ? path.join(baseDir, relativePath) : baseDir;
    if (!(await fs.pathExists(fullDir))) return;

    const entries = await fs.readdir(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === META_DIR) continue;

      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const full = path.join(fullDir, entry.name);

      if (entry.isDirectory()) {
        await this.cleanupStaleDirectory(baseDir, rel, remoteFiles, remoteFolders);
        if (!remoteFolders.has(rel)) {
          const remaining = await fs.readdir(full);
          if (remaining.length === 0) {
            await fs.remove(full);
            logger.info(`Removed empty directory: ${rel}`);
          }
        }
      } else if (!remoteFiles.has(rel)) {
        await fs.remove(full);
        logger.info(`Removed stale file: ${rel}`);
      }
    }
  }

  // ====== Private: base-cache ======

  private async writeBaseCache(localPath: string, manifest: RemoteManifest): Promise<void> {
    const baseCacheDir = path.join(localPath, META_DIR, BASE_CACHE_DIR);
    await fs.ensureDir(baseCacheDir);
    for (const doc of manifest.docs) {
      const cacheKey = doc.relativePath.replace(/[\\/]/g, '_');
      await fs.writeFile(path.join(baseCacheDir, cacheKey), doc.content, 'utf-8');
    }
  }

  // ====== Private: utilities ======

  private sanitizeProjectName(name: string): string {
    return (
      name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 100) || 'untitled'
    );
  }
}
