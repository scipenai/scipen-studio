/**
 * @file LocalReplicaService - Local-remote file synchronization
 * @description Provides bidirectional sync between Overleaf remote projects and local filesystem.
 * @depends IOverleafService, IOverleafFileSystemService, IFileSystemService, chokidar, diff-match-patch
 * @implements ILocalReplicaService
 *
 * Features:
 * - Bidirectional auto-sync (chokidar + Socket events)
 * - Anti-loop sync mechanism (bypass cache)
 * - Three-way merge conflict resolution (diff-match-patch)
 *
 * Reference: Overleaf-Workshop/src/scm/localReplicaSCM.ts
 */

import { EventEmitter } from 'events';
import path from 'path';
import { type FSWatcher, watch } from 'chokidar';
import DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { configManager } from './ConfigManager';
import { createLogger } from './LoggerService';
import type { IFileSystemService } from './interfaces/IFileSystemService';
import type {
  ILocalReplicaService,
  LocalReplicaConfig,
  SyncProgressEvent,
  SyncResult,
} from './interfaces/ILocalReplicaService';
import { DEFAULT_IGNORE_PATTERNS } from './interfaces/ILocalReplicaService';
import type { IOverleafFileSystemService } from './interfaces/IOverleafFileSystemService';
import type { IOverleafService } from './interfaces/IOverleafService';
import fs from './knowledge/utils/fsCompat';

const logger = createLogger('LocalReplicaService');

// ====== Configuration Storage Key ======

const CONFIG_KEY = 'localReplica';

// ====== Anti-loop Sync Cache ======

/** File cache entry for loop prevention */
interface FileCache {
  date: number;
  hash: number;
}

/** Computes content hash (reference: Overleaf-Workshop) */
function hashCode(content?: Buffer | string): number {
  if (content === undefined) return -1;
  const str = typeof content === 'string' ? content : content.toString('utf-8');

  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

// ====== Event Serialization Types ======

/** Pending local change event */
interface PendingLocalEvent {
  type: 'add' | 'unlink' | 'change' | 'addDir' | 'unlinkDir';
  path: string; // Absolute path
  relativePath: string; // Relative path
  timestamp: number;
}

/** Pending remote operation */
interface RemoteAction {
  type: 'move' | 'delete' | 'create' | 'update' | 'createDir' | 'deleteDir';
  fromPath?: string; // Source path for move operations
  toPath: string; // Target path
  content?: Buffer; // Content for create/update operations
}

// ====== Service Implementation ======

export class LocalReplicaService extends EventEmitter implements ILocalReplicaService {
  private config: LocalReplicaConfig | null = null;
  private ignorePatterns: string[] = [];
  private isWatchingFlag = false;

  // Phase 3: Watchers
  private localWatcher: FSWatcher | null = null;
  private socketListeners: Array<() => void> = [];

  // Phase 3: Anti-loop cache [push cache, pull cache]
  private bypassCache: Map<string, [FileCache, FileCache]> = new Map();
  // Phase 3: Base content cache (for three-way merge)
  private baseCache: Map<string, Buffer> = new Map();
  // Phase 3: Debounce window (ms)
  private readonly bypassWindow = 500;

  // Phase 3: diff-match-patch instance
  private dmp = new DiffMatchPatch();

  // Phase 3: entityId → path mapping cache (for delete/rename/move events)
  private entityPathCache: Map<string, string> = new Map();

  // Phase 4: Event buffering and serialization
  private pendingEvents: PendingLocalEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly bufferWindow = 100; // ms
  private executionQueue: RemoteAction[] = [];
  private isProcessingQueue = false;

  // Optional dependency: FileSystemService (for updating mtime cache)
  private fileSystemService: IFileSystemService | null = null;

  constructor(
    private overleafService: IOverleafService,
    private overleafFileSystem: IOverleafFileSystemService
  ) {
    super();
    logger.info('LocalReplicaService initialized');

    // Try to load saved config from ConfigManager
    this.loadSavedConfig();
  }

  /**
   * Sets FileSystemService reference (for updating mtime cache after writes).
   *
   * This is an optional dependency since LocalReplicaService can work independently,
   * but setting it avoids FileSystemService false-positives on "external modification".
   */
  setFileSystemService(service: IFileSystemService): void {
    this.fileSystemService = service;
    logger.info('[LocalReplicaService] FileSystemService injected');
  }

  /**
   * Updates mtime cache after file write.
   *
   * Calls FileSystemService.updateFileMtime to ensure Watcher doesn't misidentify as external change.
   */
  private async notifyFileWritten(localPath: string): Promise<void> {
    if (!this.fileSystemService) return;

    try {
      const stats = await fs.stat(localPath);
      this.fileSystemService.updateFileMtime(localPath, stats.mtimeMs);
    } catch (error) {
      // File may have just been deleted
      logger.debug(`[mtime update failed] ${localPath}`, error);
    }
  }

  // ====== Initialization & Configuration ======

  async init(config: LocalReplicaConfig): Promise<boolean> {
    try {
      logger.info(`Initializing Local Replica: ${config.projectName} -> ${config.localPath}`);

      // Clear caches when switching projects/reinitializing to avoid stale paths
      this.entityPathCache.clear();
      this.baseCache.clear();
      this.bypassCache.clear();

      // Validate local path
      const localPathExists = await fs.pathExists(config.localPath);
      if (!localPathExists) {
        // Try to create directory
        await fs.ensureDir(config.localPath);
        logger.info(`Created local directory: ${config.localPath}`);
      }

      // Validate write permissions
      try {
        const testFile = path.join(config.localPath, '.scipen-test-write');
        await fs.writeFile(testFile, 'test');
        await fs.remove(testFile);
      } catch (error) {
        logger.error(`Local directory not writable: ${config.localPath}`, error);
        return false;
      }

      // Write .overleaf/settings.json config file (reference: Overleaf-Workshop)
      await this.writeOverleafSettings(config);

      // Build ignore patterns
      this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.customIgnorePatterns || [])];

      // Save configuration
      this.config = config;
      this.saveConfig();

      logger.info('Local Replica initialized successfully');
      return true;
    } catch (error) {
      logger.error('Local Replica initialization failed', error);
      return false;
    }
  }

  /**
   * Writes .overleaf/settings.json (to identify local replica).
   */
  private async writeOverleafSettings(config: LocalReplicaConfig): Promise<void> {
    const settingsDir = path.join(config.localPath, '.overleaf');
    const settingsFile = path.join(settingsDir, 'settings.json');

    await fs.ensureDir(settingsDir);
    await fs.writeJson(settingsFile, {
      projectId: config.projectId,
      projectName: config.projectName,
      serverUrl: this.overleafService.getServerUrl(),
      enableCompileNPreview: false,
    });
  }

  getConfig(): LocalReplicaConfig | null {
    return this.config;
  }

  isEnabled(): boolean {
    return this.config?.enabled ?? false;
  }

  setEnabled(enabled: boolean): void {
    if (this.config) {
      this.config.enabled = enabled;
      this.saveConfig();

      if (enabled) {
        logger.info('Local Replica enabled');
      } else {
        logger.info('Local Replica disabled');
        this.stopWatching();
      }
    }
  }

  // ====== Sync Operations ======

  async syncFromRemote(): Promise<SyncResult> {
    if (!this.config) {
      return {
        synced: 0,
        skipped: 0,
        errors: ['Local Replica config not initialized'],
        conflicts: [],
      };
    }

    const result: SyncResult = {
      synced: 0,
      skipped: 0,
      errors: [],
      conflicts: [],
    };

    try {
      logger.info(
        `Starting sync from remote: ${this.config.projectId} -> ${this.config.localPath}`
      );

      this.emit('sync:progress', {
        progress: 0,
        message: 'Fetching remote file list...',
      } as SyncProgressEvent);

      // Get project details for file tree
      const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
        this.config.projectId
      );

      if (!projectDetails?.rootFolder?.[0]) {
        result.errors.push('Unable to get remote project details');
        return result;
      }

      // Build entityId → path mapping cache (for subsequent event handling)
      this.entityPathCache.clear();
      this.buildEntityPathCache(projectDetails.rootFolder[0] as FolderEntity, '');

      // Collect all files and folders
      const files: Array<{ path: string; id: string; type: 'doc' | 'file' }> = [];
      this.collectFiles(projectDetails.rootFolder[0] as FolderEntity, '', files);
      const folders: string[] = [];
      this.collectFolders(projectDetails.rootFolder[0] as FolderEntity, '', folders);

      logger.info(
        `Found ${files.length} files, ${folders.length} folders, cached ${this.entityPathCache.size} entity paths`
      );

      // Create local folders first (including empty folders)
      for (const folderPath of folders) {
        const relPath = folderPath ? `${folderPath}/` : '';
        if (relPath && this.shouldIgnore(relPath)) {
          result.skipped++;
          continue;
        }
        const localPath = path.join(this.config.localPath, folderPath);
        await fs.ensureDir(localPath);
      }

      // Filter ignored files
      const filesToSync = files.filter((f) => !this.shouldIgnore(f.path));
      result.skipped = files.length - filesToSync.length;

      logger.info(`After filtering, ${filesToSync.length} files need to sync`);

      // Sync each file (with three-way merge)
      for (let i = 0; i < filesToSync.length; i++) {
        const file = filesToSync[i];
        const progress = Math.round(((i + 1) / filesToSync.length) * 100);

        this.emit('sync:progress', {
          progress,
          currentFile: file.path,
          message: `Syncing: ${file.path}`,
        } as SyncProgressEvent);

        try {
          await this.syncFileFromRemote(file);
          result.synced++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push(`${file.path}: ${errorMsg}`);
          logger.error(`Failed to sync file: ${file.path}`, error);
        }
      }

      logger.info(
        `Sync completed: ${result.synced} succeeded, ${result.skipped} skipped, ${result.errors.length} failed`
      );

      this.emit('sync:completed', result);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Sync failed: ${errorMsg}`);
      logger.error('syncFromRemote failed', error);

      this.emit('sync:error', error instanceof Error ? error : new Error(errorMsg));
      return result;
    }
  }

  /**
   * Syncs single file (with three-way merge).
   */
  private async syncFileFromRemote(file: {
    path: string;
    id: string;
    type: 'doc' | 'file';
  }): Promise<void> {
    if (!this.config) throw new Error('Not initialized');

    const relPath = `/${file.path}`;
    const localPath = path.join(this.config.localPath, file.path);

    // Get remote content
    let remoteContent: Buffer;
    if (file.type === 'doc') {
      const content = await this.overleafFileSystem.getDoc(this.config.projectId, file.id);
      if (content === null) throw new Error('Unable to get document content');
      remoteContent = Buffer.from(content, 'utf-8');
    } else {
      const content = await this.overleafFileSystem.downloadFile(this.config.projectId, file.id);
      if (!content) throw new Error('Unable to download file');
      remoteContent = content;
    }

    // Get local content (if exists)
    let localContent: Buffer | undefined;
    try {
      localContent = await fs.readFile(localPath);
    } catch {
      // File doesn't exist
    }

    // Get base content
    const baseContent = this.baseCache.get(relPath);

    // Ensure parent directory exists
    await fs.ensureDir(path.dirname(localPath));

    // Determine if three-way merge is needed
    if (baseContent && localContent && file.type === 'doc') {
      const localHash = hashCode(localContent);
      const baseHash = hashCode(baseContent);
      const remoteHash = hashCode(remoteContent);

      // If both local and remote have changes (relative to base), need three-way merge
      const localChanged = localHash !== baseHash;
      const remoteChanged = remoteHash !== baseHash;

      if (localChanged && remoteChanged) {
        // Three-way merge
        const mergeResult = this.threeWayMerge(baseContent, localContent, remoteContent, file.path);

        if (mergeResult.hasConflict) {
          // Generate conflict copy
          const conflictPath = this.generateConflictPath(localPath);
          await fs.writeFile(conflictPath, localContent);
          logger.warn(`Conflict detected, generated conflict copy: ${conflictPath}`);

          // Emit conflict event
          this.emit('sync:conflict', {
            path: file.path,
            localHash: String(localHash),
            remoteHash: String(remoteHash),
            localMtime: Date.now(),
          });
        }

        await fs.writeFileAtomic(localPath, mergeResult.content);
        await this.notifyFileWritten(localPath);
        this.setBypassCache(relPath, mergeResult.content);
        this.baseCache.set(relPath, mergeResult.content);

        // Push merge result to remote
        await this.overleafFileSystem.updateDoc(
          this.config.projectId,
          file.id,
          mergeResult.content.toString('utf-8')
        );
      } else if (remoteChanged) {
        // Only remote changed, use remote version directly
        await fs.writeFileAtomic(localPath, remoteContent);
        await this.notifyFileWritten(localPath);
        this.setBypassCache(relPath, remoteContent);
        this.baseCache.set(relPath, remoteContent);
      }
      // If only local changed, keep local version (will sync on next push)
    } else {
      // Direct overwrite (no base or non-document)
      await fs.writeFileAtomic(localPath, remoteContent);
      await this.notifyFileWritten(localPath);
      this.setBypassCache(relPath, remoteContent);
      this.baseCache.set(relPath, remoteContent);
    }
  }

  /**
   * Generates conflict copy path.
   */
  private generateConflictPath(originalPath: string): string {
    const ext = path.extname(originalPath);
    const base = originalPath.slice(0, -ext.length || undefined);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${base}.conflict.${timestamp}${ext}`;
  }

  /**
   * Three-way merge (reference: Overleaf-Workshop).
   * @returns Merge result and whether there's conflict
   */
  private threeWayMerge(
    base: Buffer,
    local: Buffer,
    remote: Buffer,
    filePath: string
  ): { content: Buffer; hasConflict: boolean } {
    const baseStr = base.toString('utf-8');
    const localStr = local.toString('utf-8');
    const remoteStr = remote.toString('utf-8');

    // Use diff-match-patch for merging
    const remotePatches = this.dmp.patch_make(baseStr, remoteStr);
    const [mergedStr, results] = this.dmp.patch_apply(remotePatches, localStr);

    // Check if all patches were applied successfully
    const hasConflict = results.some((applied) => !applied);

    if (hasConflict) {
      logger.warn(`Three-way merge has conflict: ${filePath}`);
    }

    return {
      content: Buffer.from(mergedStr, 'utf-8'),
      hasConflict,
    };
  }

  async syncToRemote(): Promise<SyncResult> {
    if (!this.config) {
      return {
        synced: 0,
        skipped: 0,
        errors: ['Local Replica config not initialized'],
        conflicts: [],
      };
    }

    const result: SyncResult = {
      synced: 0,
      skipped: 0,
      errors: [],
      conflicts: [],
    };

    try {
      logger.info(
        `Starting sync from local to remote: ${this.config.localPath} -> ${this.config.projectId}`
      );

      this.emit('sync:progress', {
        progress: 0,
        message: 'Scanning local files...',
      } as SyncProgressEvent);

      // Collect local files
      const localFiles: string[] = [];
      await this.collectLocalFiles(this.config.localPath, '', localFiles);
      const localFolders: string[] = [];
      await this.collectLocalFolders(this.config.localPath, '', localFolders);

      logger.info(`Found ${localFiles.length} local files, ${localFolders.length} local folders`);

      // Filter ignored files
      const filesToSync = localFiles.filter((f) => !this.shouldIgnore(f));
      result.skipped = localFiles.length - filesToSync.length;

      logger.info(`After filtering, ${filesToSync.length} files need to upload`);

      // Get project details to get root folder ID
      const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
        this.config.projectId
      );

      if (!projectDetails?.rootFolder?.[0]) {
        result.errors.push('Unable to get remote project details');
        return result;
      }

      const rootFolderId = (projectDetails.rootFolder[0] as FolderEntity)._id;

      // Create remote folders first (including empty folders)
      for (const folderPath of localFolders) {
        const relPath = folderPath ? `${folderPath}/` : '';
        if (relPath && this.shouldIgnore(relPath)) {
          result.skipped++;
          continue;
        }
        try {
          await this.ensureRemoteFolder(folderPath, projectDetails.rootFolder[0] as FolderEntity);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push(`${folderPath}: ${errorMsg}`);
          logger.error(`Failed to create remote folder: ${folderPath}`, error);
        }
      }

      // Upload each file
      for (let i = 0; i < filesToSync.length; i++) {
        const relativePath = filesToSync[i];
        const progress = Math.round(((i + 1) / filesToSync.length) * 100);

        this.emit('sync:progress', {
          progress,
          currentFile: relativePath,
          message: `Uploading: ${relativePath}`,
        } as SyncProgressEvent);

        try {
          await this.uploadFile(
            relativePath,
            rootFolderId,
            projectDetails.rootFolder[0] as FolderEntity
          );
          result.synced++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push(`${relativePath}: ${errorMsg}`);
          logger.error(`Failed to upload file: ${relativePath}`, error);
        }
      }

      logger.info(
        `Upload completed: ${result.synced} succeeded, ${result.skipped} skipped, ${result.errors.length} failed`
      );

      this.emit('sync:completed', result);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Upload failed: ${errorMsg}`);
      logger.error('syncToRemote failed', error);

      this.emit('sync:error', error instanceof Error ? error : new Error(errorMsg));
      return result;
    }
  }

  // ====== Phase 3: Bidirectional Watching ======

  startWatching(): void {
    if (!this.config?.enabled) {
      logger.warn('Local Replica not enabled, cannot start watching');
      return;
    }

    if (this.isWatchingFlag) {
      logger.warn('Local Replica already watching');
      return;
    }

    logger.info('Starting bidirectional watching');
    this.isWatchingFlag = true;

    // 1. Use chokidar to watch local file changes
    this.startLocalWatcher();

    // 2. Subscribe to Overleaf Socket events
    this.startSocketListener();
  }

  /**
   * Starts local file watcher (chokidar).
   */
  private startLocalWatcher(): void {
    if (!this.config) return;

    logger.info(`Starting local file watcher: ${this.config.localPath}`);

    this.localWatcher = watch(this.config.localPath, {
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.config!.localPath, filePath);
        return this.shouldIgnore(relativePath);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // File changes -> add to event buffer (using new serialization mechanism)
    this.localWatcher.on('change', (filePath: string) => {
      this.enqueueLocalEvent('change', filePath);
    });

    this.localWatcher.on('add', (filePath: string) => {
      this.enqueueLocalEvent('add', filePath);
    });

    this.localWatcher.on('addDir', (dirPath: string) => {
      this.enqueueLocalEvent('addDir', dirPath);
    });

    this.localWatcher.on('unlink', (filePath: string) => {
      this.enqueueLocalEvent('unlink', filePath);
    });

    this.localWatcher.on('unlinkDir', (dirPath: string) => {
      this.enqueueLocalEvent('unlinkDir', dirPath);
    });

    this.localWatcher.on('error', (error) => {
      logger.error('Local file watcher error', error);
    });
  }

  // ====== Phase 4: Event Buffering & Serialization ======

  /**
   * Adds local event to buffer (debounced).
   */
  private enqueueLocalEvent(type: PendingLocalEvent['type'], absolutePath: string): void {
    if (!this.config) return;

    const relativePath = this.normalizeRelativePath(
      path.relative(this.config.localPath, absolutePath)
    );

    // Ignore check
    if (this.shouldIgnore(relativePath)) return;

    this.pendingEvents.push({
      type,
      path: absolutePath,
      relativePath,
      timestamp: Date.now(),
    });

    // Reset timer (debounce)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => this.flushPendingEvents(), this.bufferWindow);
  }

  /**
   * Processes buffered events (move detection + action generation).
   */
  private async flushPendingEvents(): Promise<void> {
    if (this.pendingEvents.length === 0) return;

    const events = [...this.pendingEvents];
    this.pendingEvents = [];

    const actions: RemoteAction[] = [];
    const processedIndices = new Set<number>();

    // 1. Detect moves (unlink + add with same basename)
    // Use smart pairing strategy: when multiple files with same name, prefer closest timestamp
    const unlinkEvents = events
      .map((e, i) => ({ event: e, index: i }))
      .filter((x) => x.event.type === 'unlink');
    const addEvents = events
      .map((e, i) => ({ event: e, index: i }))
      .filter((x) => x.event.type === 'add');

    for (const unlinkItem of unlinkEvents) {
      if (processedIndices.has(unlinkItem.index)) continue;

      const basename = path.basename(unlinkItem.event.relativePath);
      const unlinkParent = path.dirname(unlinkItem.event.relativePath);

      // Find all add events with same basename that haven't been processed
      const matchingAdds = addEvents.filter(
        (addItem) =>
          !processedIndices.has(addItem.index) &&
          path.basename(addItem.event.relativePath) === basename
      );

      if (matchingAdds.length === 0) continue;

      // If only one match, pair directly
      // If multiple matches, use heuristics to select best pair
      let bestMatch = matchingAdds[0];

      if (matchingAdds.length > 1) {
        // Heuristic 1: Prefer different parent directory (real move)
        // Heuristic 2: If all different, choose closest timestamp
        const differentParentAdds = matchingAdds.filter(
          (addItem) => path.dirname(addItem.event.relativePath) !== unlinkParent
        );

        if (differentParentAdds.length === 1) {
          bestMatch = differentParentAdds[0];
        } else if (differentParentAdds.length > 1) {
          // Multiple adds with different parents, choose closest timestamp
          bestMatch = differentParentAdds.reduce((best, curr) =>
            Math.abs(curr.event.timestamp - unlinkItem.event.timestamp) <
            Math.abs(best.event.timestamp - unlinkItem.event.timestamp)
              ? curr
              : best
          );
        } else {
          // All adds in same parent (possibly copy then delete original), choose closest timestamp
          bestMatch = matchingAdds.reduce((best, curr) =>
            Math.abs(curr.event.timestamp - unlinkItem.event.timestamp) <
            Math.abs(best.event.timestamp - unlinkItem.event.timestamp)
              ? curr
              : best
          );
        }
      }

      // Extra check: if unlink and add paths are identical, not a move (possibly editor save behavior)
      if (unlinkItem.event.relativePath === bestMatch.event.relativePath) {
        continue;
      }

      // Read content from new location
      const content = await fs.readFile(bestMatch.event.path).catch(() => undefined);
      actions.push({
        type: 'move',
        fromPath: unlinkItem.event.relativePath,
        toPath: bestMatch.event.relativePath,
        content,
      });
      processedIndices.add(unlinkItem.index);
      processedIndices.add(bestMatch.index);
      logger.info(
        `[Event merge] Detected as move: ${unlinkItem.event.relativePath} -> ${bestMatch.event.relativePath}`
      );
    }

    // Similarly: detect directory moves (unlinkDir + addDir)
    const unlinkDirEvents = events
      .map((e, i) => ({ event: e, index: i }))
      .filter((x) => x.event.type === 'unlinkDir');
    const addDirEvents = events
      .map((e, i) => ({ event: e, index: i }))
      .filter((x) => x.event.type === 'addDir');

    for (const unlinkDirItem of unlinkDirEvents) {
      if (processedIndices.has(unlinkDirItem.index)) continue;

      const basename = path.basename(unlinkDirItem.event.relativePath);
      const unlinkParent = path.dirname(unlinkDirItem.event.relativePath);

      const matchingAddDirs = addDirEvents.filter(
        (addDirItem) =>
          !processedIndices.has(addDirItem.index) &&
          path.basename(addDirItem.event.relativePath) === basename
      );

      if (matchingAddDirs.length === 0) continue;

      let bestMatch = matchingAddDirs[0];

      if (matchingAddDirs.length > 1) {
        const differentParentAddDirs = matchingAddDirs.filter(
          (addDirItem) => path.dirname(addDirItem.event.relativePath) !== unlinkParent
        );

        if (differentParentAddDirs.length === 1) {
          bestMatch = differentParentAddDirs[0];
        } else if (differentParentAddDirs.length > 1) {
          bestMatch = differentParentAddDirs.reduce((best, curr) =>
            Math.abs(curr.event.timestamp - unlinkDirItem.event.timestamp) <
            Math.abs(best.event.timestamp - unlinkDirItem.event.timestamp)
              ? curr
              : best
          );
        } else {
          bestMatch = matchingAddDirs.reduce((best, curr) =>
            Math.abs(curr.event.timestamp - unlinkDirItem.event.timestamp) <
            Math.abs(best.event.timestamp - unlinkDirItem.event.timestamp)
              ? curr
              : best
          );
        }
      }

      if (unlinkDirItem.event.relativePath === bestMatch.event.relativePath) {
        continue;
      }

      actions.push({
        type: 'move',
        fromPath: unlinkDirItem.event.relativePath,
        toPath: bestMatch.event.relativePath,
      });
      processedIndices.add(unlinkDirItem.index);
      processedIndices.add(bestMatch.index);
      logger.info(
        `[Event merge] Detected as directory move: ${unlinkDirItem.event.relativePath} -> ${bestMatch.event.relativePath}`
      );
    }

    // 2. Process remaining events (unpaired)
    for (let i = 0; i < events.length; i++) {
      if (processedIndices.has(i)) continue;
      const e = events[i];

      switch (e.type) {
        case 'unlink':
          actions.push({ type: 'delete', toPath: e.relativePath });
          break;
        case 'add':
        case 'change': {
          const content = await fs.readFile(e.path).catch(() => undefined);
          if (content) {
            actions.push({
              type: e.type === 'add' ? 'create' : 'update',
              toPath: e.relativePath,
              content,
            });
          }
          break;
        }
        case 'addDir':
          actions.push({ type: 'createDir', toPath: e.relativePath });
          break;
        case 'unlinkDir':
          actions.push({ type: 'deleteDir', toPath: e.relativePath });
          break;
      }
    }

    // 3. Add to execution queue and start processing
    if (actions.length > 0) {
      this.executionQueue.push(...actions);
      this.processQueue();
    }
  }

  /**
   * Serially executes remote operations in queue.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.executionQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.executionQueue.length > 0) {
      const action = this.executionQueue.shift()!;
      try {
        await this.executeRemoteAction(action);
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : JSON.stringify(error, Object.getOwnPropertyNames(error));
        logger.error(
          `Failed to execute remote action: ${action.type} ${action.toPath} (${errorMsg})`,
          error
        );

        // @stability P2 enhancement: emit sync error event to notify UI
        this.emit(
          'sync:error',
          new Error(`Sync failed (${action.type} ${action.toPath}): ${errorMsg}`)
        );
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Executes single remote action.
   */
  private async executeRemoteAction(action: RemoteAction): Promise<void> {
    if (!this.config) return;

    const relPath = `/${action.toPath}`;

    // Anti-loop check
    if (!this.shouldPropagate('push', relPath, action.content)) {
      logger.info(`[Skip] ${action.type} "${relPath}" (anti-loop)`);
      return;
    }

    logger.info(`[Serial execute] ${action.type} "${relPath}"`);

    switch (action.type) {
      case 'move':
        await this.executeMove(action);
        break;
      case 'delete':
        await this.executeDelete(action);
        break;
      case 'create':
      case 'update':
        await this.executeCreateOrUpdate(action);
        break;
      case 'createDir':
        await this.executeCreateDir(action);
        break;
      case 'deleteDir':
        await this.executeDeleteDir(action);
        break;
    }
  }

  /**
   * Executes delete operation.
   */
  private async executeDelete(action: RemoteAction): Promise<void> {
    if (!this.config) return;

    const entity = await this.overleafFileSystem.resolvePathToEntity(
      this.config.projectId,
      action.toPath
    );
    if (entity) {
      const deleted = await this.overleafFileSystem.deleteEntity(
        this.config.projectId,
        entity.type,
        entity.id
      );
      if (!deleted) {
        throw new Error(`Failed to delete remote entity: ${action.toPath}`);
      }
    }
    this.baseCache.delete(`/${action.toPath}`);
  }

  /**
   * Executes create or update operation.
   */
  private async executeCreateOrUpdate(action: RemoteAction): Promise<void> {
    if (!this.config || !action.content) return;

    const relativePath = action.toPath;
    const relPath = `/${relativePath}`;
    const fileName = path.basename(relativePath);
    const isText = this.isTextFile(fileName);

    if (isText) {
      // Text file handling
      const existing = await this.overleafFileSystem.getDocByPath(
        this.config.projectId,
        relativePath
      );

      if (existing) {
        // Update existing document
        const updateResult = await this.overleafFileSystem.updateDoc(
          this.config.projectId,
          existing.docId,
          action.content.toString('utf-8')
        );
        if (!updateResult.success) {
          throw new Error(`Failed to update remote document: ${relativePath}`);
        }
      } else {
        // Create new document
        const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
          this.config.projectId
        );
        if (projectDetails?.rootFolder?.[0]) {
          await this.uploadFile(
            relativePath,
            (projectDetails.rootFolder[0] as FolderEntity)._id,
            projectDetails.rootFolder[0] as FolderEntity
          );
        }
      }
    } else {
      // Binary file handling
      // Note: Overleaf doesn't support same-name binary file overwrite, must delete before upload.
      // This creates a brief window where file doesn't exist on remote.
      const existingEntity = await this.overleafFileSystem.resolvePathToEntity(
        this.config.projectId,
        relativePath
      );

      const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
        this.config.projectId
      );
      if (projectDetails?.rootFolder?.[0]) {
        if (existingEntity && existingEntity.type === 'file') {
          const deleteSuccess = await this.overleafFileSystem.deleteEntity(
            this.config.projectId,
            'file',
            existingEntity.id
          );
          if (!deleteSuccess) {
            throw new Error(`Failed to delete old file: ${relativePath}`);
          }
        }

        await this.uploadFile(
          relativePath,
          (projectDetails.rootFolder[0] as FolderEntity)._id,
          projectDetails.rootFolder[0] as FolderEntity
        );
      }
    }

    this.baseCache.set(relPath, action.content);
  }

  /**
   * Executes create directory operation.
   */
  private async executeCreateDir(action: RemoteAction): Promise<void> {
    if (!this.config) return;

    const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
      this.config.projectId
    );
    if (projectDetails?.rootFolder?.[0]) {
      await this.ensureRemoteFolder(action.toPath, projectDetails.rootFolder[0] as FolderEntity);
    }
  }

  /**
   * Executes delete directory operation.
   */
  private async executeDeleteDir(action: RemoteAction): Promise<void> {
    if (!this.config) return;
    await this.deleteRemoteFolderRecursive(action.toPath);
  }

  /**
   * Executes move operation (move + optional rename + update).
   */
  private async executeMove(action: RemoteAction): Promise<void> {
    if (!this.config || !action.fromPath) return;

    const fromPath = action.fromPath;
    const toPath = action.toPath;
    const fromRelPath = `/${fromPath}`;
    const toRelPath = `/${toPath}`;

    // 1. Find source entity
    const sourceEntity = await this.overleafFileSystem.resolvePathToEntity(
      this.config.projectId,
      fromPath
    );

    if (!sourceEntity) {
      // Source entity doesn't exist, downgrade to create operation
      // @stability P2 enhancement: emit error event on downgrade create failure
      logger.warn(`Move source doesn't exist, downgrading to create: ${fromPath} -> ${toPath}`);
      if (action.content) {
        try {
          await this.executeCreateOrUpdate({ type: 'create', toPath, content: action.content });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Downgrade create failed: ${toPath}`, error);
          // Emit sync error event to notify UI
          this.emit('sync:error', new Error(`File sync failed (${toPath}): ${errorMsg}`));
          throw error;
        }
      }
      return;
    }

    // 2. Parse target path
    const toPathParts = toPath.split('/').filter((p) => p.length > 0);
    const toFileName = toPathParts.pop() || toPath;
    const toParentPath = toPathParts.join('/');

    // 3. Ensure target parent directory exists
    let targetFolderId: string;
    if (toParentPath) {
      const resolvedFolderId = await this.overleafFileSystem.resolveFolderIdByPath(
        this.config.projectId,
        toParentPath
      );
      if (resolvedFolderId) {
        targetFolderId = resolvedFolderId;
      } else {
        // Need to create parent directory
        const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
          this.config.projectId
        );
        if (!projectDetails?.rootFolder?.[0]) {
          throw new Error('Unable to get project root directory');
        }
        targetFolderId = await this.ensureRemoteFolder(
          toParentPath,
          projectDetails.rootFolder[0] as FolderEntity
        );
      }
    } else {
      // Move to root directory
      const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
        this.config.projectId
      );
      if (!projectDetails?.rootFolder?.[0]) {
        throw new Error('Unable to get project root directory');
      }
      targetFolderId = (projectDetails.rootFolder[0] as FolderEntity)._id;
    }

    // 4. Execute move
    const moveSuccess = await this.overleafFileSystem.moveEntity(
      this.config.projectId,
      sourceEntity.type,
      sourceEntity.id,
      targetFolderId
    );

    if (!moveSuccess) {
      throw new Error(`Failed to move remote entity: ${fromPath} -> ${toPath}`);
    }

    logger.info(`Move succeeded: ${fromPath} -> folder/${targetFolderId}`);

    // 5. If filename changed, execute rename
    const fromFileName = path.basename(fromPath);
    if (toFileName !== fromFileName) {
      const renameSuccess = await this.overleafFileSystem.renameEntity(
        this.config.projectId,
        sourceEntity.type,
        sourceEntity.id,
        toFileName
      );
      if (!renameSuccess) {
        throw new Error(`Failed to rename remote entity: ${fromFileName} -> ${toFileName}`);
      }
      logger.info(`Rename succeeded: ${fromFileName} -> ${toFileName}`);
    }

    // 6. If has content and is document, update content (prevent content changes during move)
    if (action.content && sourceEntity.type === 'doc') {
      const updateResult = await this.overleafFileSystem.updateDoc(
        this.config.projectId,
        sourceEntity.id,
        action.content.toString('utf-8')
      );
      if (updateResult.success) {
        logger.info(`Content update succeeded: ${toPath}`);
      }
    }

    // 7. Update cache
    this.baseCache.delete(fromRelPath);
    if (action.content) {
      this.baseCache.set(toRelPath, action.content);
    }
  }

  /**
   * Recursively deletes remote folder (delete contents first, then directory).
   */
  private async deleteRemoteFolderRecursive(folderPath: string): Promise<void> {
    if (!this.config) return;

    const entity = await this.overleafFileSystem.resolvePathToEntity(
      this.config.projectId,
      folderPath
    );

    if (!entity || entity.type !== 'folder') {
      logger.warn(`Remote folder doesn't exist or type mismatch: ${folderPath}`);
      return;
    }

    // Get folder contents
    const contents = await this.overleafFileSystem.listFolder(this.config.projectId, entity.id);

    // Recursively delete subfolders and files first
    for (const item of contents) {
      if (item.type === 'folder') {
        const subPath = `${folderPath}/${item.name}`;
        await this.deleteRemoteFolderRecursive(subPath);
      } else {
        // Delete file or document
        try {
          await this.overleafFileSystem.deleteEntity(this.config.projectId, item.type, item.id);
          logger.info(`Deleted remote file: ${folderPath}/${item.name}`);
        } catch (error) {
          logger.error(`Failed to delete remote file: ${folderPath}/${item.name}`, error);
        }
      }
    }

    // Finally delete empty folder
    try {
      await this.overleafFileSystem.deleteEntity(this.config.projectId, 'folder', entity.id);
      logger.info(`Deleted remote folder: ${folderPath}`);
    } catch (error) {
      logger.error(`Failed to delete remote folder: ${folderPath}`, error);
    }
  }

  /**
   * Subscribes to Overleaf Socket events (using formal interface).
   */
  private startSocketListener(): void {
    if (!this.config) return;

    logger.info('Subscribing to Overleaf Socket events');

    // Check if Socket connection is available
    if (!this.overleafService.isProjectConnected(this.config.projectId)) {
      logger.warn('Cannot get Socket connection, remote event listening not enabled');
      return;
    }

    // Subscribe to events using formal interface
    const unsubscribe = this.overleafService.subscribeToProjectEvents(this.config.projectId, {
      // Document content changed
      onDocChanged: async (docId) => {
        await this.handleRemoteDocChange(docId);
      },
      // New document created
      onDocCreated: async (parentFolderId, doc) => {
        await this.handleRemoteDocCreated(parentFolderId, doc);
      },
      // New file created
      onFileCreated: async (parentFolderId, file) => {
        await this.handleRemoteFileCreated(parentFolderId, file);
      },
      // New folder created
      onFolderCreated: async (parentFolderId, folder) => {
        await this.handleRemoteFolderCreated(parentFolderId, folder);
      },
      // Entity renamed
      onEntityRenamed: async (entityId, newName) => {
        await this.handleRemoteEntityRenamed(entityId, newName);
      },
      // Entity moved
      onEntityMoved: async (entityId, newFolderId) => {
        await this.handleRemoteEntityMoved(entityId, newFolderId);
      },
      // Entity removed
      onEntityRemoved: async (entityId) => {
        await this.handleRemoteEntityRemoved(entityId);
      },
    });

    if (unsubscribe) {
      this.socketListeners.push(unsubscribe);
      logger.info('Socket event listening enabled');
    }
  }

  /**
   * Handles remote document content change.
   */
  private async handleRemoteDocChange(docId: string): Promise<void> {
    if (!this.config) return;

    try {
      // Get document content
      const content = await this.overleafFileSystem.getDoc(this.config.projectId, docId);
      if (content === null) return;

      // Resolve docId to path
      const docPath = await this.resolveEntityPath(docId, 'doc');
      if (!docPath) return;

      const relPath = `/${docPath}`;
      const localPath = path.join(this.config.localPath, docPath);
      const contentBuffer = Buffer.from(content, 'utf-8');

      // Anti-loop check
      if (!this.shouldPropagate('pull', relPath, contentBuffer)) {
        return;
      }

      logger.info(`[pull] update "${relPath}"`);

      // Ensure parent directory exists
      await fs.ensureDir(path.dirname(localPath));

      // Write local (use atomic write to ensure data integrity)
      await fs.writeFileAtomic(localPath, contentBuffer);
      await this.notifyFileWritten(localPath);
      this.baseCache.set(relPath, contentBuffer);
    } catch (error) {
      logger.error(`Failed to pull document: docId=${docId}`, error);
    }
  }

  /**
   * Handles remote document creation.
   */
  private async handleRemoteDocCreated(
    parentFolderId: string,
    doc: { _id: string; name: string }
  ): Promise<void> {
    // Update cache
    const parentPath = await this.resolveEntityPath(parentFolderId, 'folder');
    const docPath = parentPath ? `${parentPath}/${doc.name}` : doc.name;
    this.entityPathCache.set(doc._id, docPath);

    await this.handleRemoteDocChange(doc._id);
  }

  /**
   * Handles remote file creation.
   */
  private async handleRemoteFileCreated(
    parentFolderId: string,
    file: { _id: string; name: string }
  ): Promise<void> {
    if (!this.config) return;

    try {
      // Get parent folder path
      const parentPath = await this.resolveEntityPath(parentFolderId, 'folder');
      const filePath = parentPath ? `${parentPath}/${file.name}` : file.name;
      const relPath = `/${filePath}`;
      const localPath = path.join(this.config.localPath, filePath);

      // Update cache
      this.entityPathCache.set(file._id, filePath);

      // Download file content
      const content = await this.overleafFileSystem.downloadFile(this.config.projectId, file._id);
      if (!content) return;

      // Anti-loop check
      if (!this.shouldPropagate('pull', relPath, content)) {
        return;
      }

      logger.info(`[pull] create file "${relPath}"`);

      await fs.ensureDir(path.dirname(localPath));
      await fs.writeFileAtomic(localPath, content);
      await this.notifyFileWritten(localPath);
      this.baseCache.set(relPath, content);
    } catch (error) {
      logger.error(`Failed to pull file: fileId=${file._id}`, error);
    }
  }

  /**
   * Handles remote folder creation.
   */
  private async handleRemoteFolderCreated(
    parentFolderId: string,
    folder: { _id: string; name: string }
  ): Promise<void> {
    if (!this.config) return;

    try {
      const parentPath = await this.resolveEntityPath(parentFolderId, 'folder');
      const folderPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      const relPath = `/${folderPath}/`;
      const localPath = path.join(this.config.localPath, folderPath);

      // Update cache
      this.entityPathCache.set(folder._id, folderPath);

      // Set bypass cache to prevent local watcher from pushing back
      this.setBypassCache(relPath, undefined, 'pull');

      logger.info(`[pull] create folder "${folderPath}"`);

      await fs.ensureDir(localPath);
    } catch (error) {
      logger.error(`Failed to create folder: folderId=${folder._id}`, error);
    }
  }

  /**
   * Handles remote entity rename.
   */
  private async handleRemoteEntityRenamed(entityId: string, newName: string): Promise<void> {
    if (!this.config) return;

    try {
      // Find entity's original path (need from cache or refresh project tree)
      const oldPath = await this.resolveEntityPath(entityId);
      if (!oldPath) {
        logger.warn(`Unable to resolve entity path: entityId=${entityId}`);
        return;
      }

      const oldLocalPath = path.join(this.config.localPath, oldPath);
      const parentDir = path.dirname(oldLocalPath);
      const newLocalPath = path.join(parentDir, newName);

      // Calculate new path
      const newPath = `${path.dirname(oldPath)}/${newName}`.replace(/\/+/g, '/').replace(/^\//, '');

      // Check if local file exists
      if (await fs.pathExists(oldLocalPath)) {
        logger.info(`[pull] rename "${oldPath}" -> "${newName}"`);
        await fs.rename(oldLocalPath, newLocalPath);

        // Update current entity's baseCache
        const oldRelPath = `/${oldPath}`;
        const newRelPath = `/${newPath}`;
        const cachedContent = this.baseCache.get(oldRelPath);
        if (cachedContent) {
          this.baseCache.delete(oldRelPath);
          this.baseCache.set(newRelPath, cachedContent);
        }

        // Recursively update all child entity caches (when folder renamed)
        this.updateChildPathCaches(oldPath, newPath);
      }

      // Update entityPathCache
      this.entityPathCache.set(entityId, newPath);
    } catch (error) {
      logger.error(`Rename failed: entityId=${entityId}`, error);
    }
  }

  /**
   * Handles remote entity move.
   */
  private async handleRemoteEntityMoved(entityId: string, newFolderId: string): Promise<void> {
    if (!this.config) return;

    try {
      const oldPath = await this.resolveEntityPath(entityId);
      if (!oldPath) {
        logger.warn(`Unable to resolve entity path: entityId=${entityId}`);
        return;
      }

      const newFolderPath = await this.resolveEntityPath(newFolderId, 'folder');
      const entityName = path.basename(oldPath);
      const newPath = newFolderPath ? `${newFolderPath}/${entityName}` : entityName;

      const oldLocalPath = path.join(this.config.localPath, oldPath);
      const newLocalPath = path.join(this.config.localPath, newPath);

      if (await fs.pathExists(oldLocalPath)) {
        logger.info(`[pull] move "${oldPath}" -> "${newPath}"`);
        await fs.ensureDir(path.dirname(newLocalPath));
        await fs.move(oldLocalPath, newLocalPath);

        // Update current entity's baseCache
        const oldRelPath = `/${oldPath}`;
        const newRelPath = `/${newPath}`;
        const cachedContent = this.baseCache.get(oldRelPath);
        if (cachedContent) {
          this.baseCache.delete(oldRelPath);
          this.baseCache.set(newRelPath, cachedContent);
        }

        // Recursively update all child entity caches (when folder moved)
        this.updateChildPathCaches(oldPath, newPath);
      }

      // Update entityPathCache
      this.entityPathCache.set(entityId, newPath);
    } catch (error) {
      logger.error(`Move failed: entityId=${entityId}`, error);
    }
  }

  /**
   * Recursively updates child entity path caches (for folder rename/move).
   *
   * When folder path changes from oldPathPrefix to newPathPrefix,
   * need to update all child entity caches prefixed with oldPathPrefix/.
   *
   * @param oldPathPrefix Old path prefix (without leading /)
   * @param newPathPrefix New path prefix (without leading /)
   */
  private updateChildPathCaches(oldPathPrefix: string, newPathPrefix: string): void {
    const oldPrefix = `${oldPathPrefix}/`;
    const newPrefix = `${newPathPrefix}/`;
    let updatedCount = 0;

    // 1. Update entityPathCache (ID → path mapping)
    for (const [entityId, cachedPath] of this.entityPathCache.entries()) {
      if (cachedPath.startsWith(oldPrefix)) {
        const newCachedPath = newPrefix + cachedPath.slice(oldPrefix.length);
        this.entityPathCache.set(entityId, newCachedPath);
        updatedCount++;
      }
    }

    // 2. Update baseCache (relative path → content, key format is /path)
    const baseCacheUpdates: Array<[string, Buffer]> = [];
    for (const [key, value] of this.baseCache.entries()) {
      // baseCache key format is /path, need to check /oldPathPrefix/
      if (key.startsWith(`/${oldPrefix}`)) {
        this.baseCache.delete(key);
        const newKey = `/${newPrefix}${key.slice(oldPrefix.length + 1)}`;
        baseCacheUpdates.push([newKey, value]);
      }
    }
    for (const [newKey, value] of baseCacheUpdates) {
      this.baseCache.set(newKey, value);
    }

    // 3. Update bypassCache (relative path → [push cache, pull cache], key format is /path)
    const bypassCacheUpdates: Array<[string, [FileCache, FileCache]]> = [];
    for (const [key, value] of this.bypassCache.entries()) {
      if (key.startsWith(`/${oldPrefix}`)) {
        this.bypassCache.delete(key);
        const newKey = `/${newPrefix}${key.slice(oldPrefix.length + 1)}`;
        bypassCacheUpdates.push([newKey, value]);
      }
    }
    for (const [newKey, value] of bypassCacheUpdates) {
      this.bypassCache.set(newKey, value);
    }

    if (updatedCount > 0 || baseCacheUpdates.length > 0 || bypassCacheUpdates.length > 0) {
      logger.info(
        `[Cache update] Folder path changed "${oldPathPrefix}" -> "${newPathPrefix}": ` +
          `entityPathCache=${updatedCount}, baseCache=${baseCacheUpdates.length}, bypassCache=${bypassCacheUpdates.length}`
      );
    }
  }

  /**
   * Handles remote entity removal.
   */
  private async handleRemoteEntityRemoved(entityId: string): Promise<void> {
    if (!this.config) return;

    try {
      // Find path from cache (needs to be known before deletion)
      const entityPath = await this.resolveEntityPath(entityId);
      if (!entityPath) {
        logger.warn(`Unable to resolve deleted entity path: entityId=${entityId}`);
        return;
      }

      const relPath = `/${entityPath}`;
      const localPath = path.join(this.config.localPath, entityPath);

      // Anti-loop check
      if (!this.shouldPropagate('pull', relPath, undefined)) {
        return;
      }

      if (await fs.pathExists(localPath)) {
        logger.info(`[pull] delete "${relPath}"`);
        await fs.remove(localPath);
        this.baseCache.delete(relPath);
        this.bypassCache.delete(relPath);
      }

      // Remove from entityPathCache
      this.entityPathCache.delete(entityId);
    } catch (error) {
      logger.error(`Delete failed: entityId=${entityId}`, error);
    }
  }

  /**
   * Resolves entity ID to path.
   *
   * Prefers local cache (for delete/rename/move events when entity no longer exists on server).
   */
  private async resolveEntityPath(
    entityId: string,
    expectedType?: 'doc' | 'file' | 'folder'
  ): Promise<string | null> {
    if (!this.config) return null;

    // Prefer cache (especially important for delete/rename/move events)
    if (this.entityPathCache.has(entityId)) {
      const cachedPath = this.entityPathCache.get(entityId);
      if (cachedPath === '/') return '';
      return cachedPath ?? null;
    }

    // Cache miss, try to get from server
    try {
      const projectDetails = await this.overleafService.getProjectDetailsViaSocket(
        this.config.projectId
      );
      if (!projectDetails?.rootFolder?.[0]) return null;

      const resolvedPath = this.findEntityPathById(
        projectDetails.rootFolder[0] as FolderEntity,
        entityId,
        '',
        expectedType
      );

      // If found, update cache
      if (resolvedPath) {
        this.entityPathCache.set(entityId, resolvedPath);
      }

      return resolvedPath;
    } catch {
      return null;
    }
  }

  /**
   * Finds entity path by ID (generic).
   */
  private findEntityPathById(
    folder: FolderEntity,
    entityId: string,
    currentPath: string,
    expectedType?: 'doc' | 'file' | 'folder'
  ): string | null {
    // Check if current folder
    if (folder._id === entityId && (!expectedType || expectedType === 'folder')) {
      return currentPath;
    }

    // Check documents
    if (!expectedType || expectedType === 'doc') {
      if (folder.docs) {
        for (const doc of folder.docs) {
          if (doc._id === entityId) {
            return currentPath ? `${currentPath}/${doc.name}` : doc.name;
          }
        }
      }
    }

    // Check files
    if (!expectedType || expectedType === 'file') {
      if (folder.fileRefs) {
        for (const file of folder.fileRefs) {
          if (file._id === entityId) {
            return currentPath ? `${currentPath}/${file.name}` : file.name;
          }
        }
      }
    }

    // Recursively check subfolders
    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const folderPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
        const result = this.findEntityPathById(subFolder, entityId, folderPath, expectedType);
        if (result) return result;
      }
    }

    return null;
  }

  stopWatching(): void {
    if (this.isWatchingFlag) {
      logger.info('Stopping bidirectional watching');
      this.isWatchingFlag = false;

      // Clear event buffer timer
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      // Clear pending events and execution queue
      this.pendingEvents = [];
      this.executionQueue = [];
      this.isProcessingQueue = false;

      // Stop local file watcher
      if (this.localWatcher) {
        this.localWatcher.close();
        this.localWatcher = null;
      }

      // Call unsubscribe functions
      for (const unsubscribe of this.socketListeners) {
        unsubscribe();
      }
      this.socketListeners = [];
    }
  }

  isWatching(): boolean {
    return this.isWatchingFlag;
  }

  // ====== Phase 3: Anti-loop Mechanism ======

  /**
   * Sets anti-loop cache.
   */
  private setBypassCache(
    relPath: string,
    content?: Buffer | string,
    action?: 'push' | 'pull'
  ): void {
    const date = Date.now();
    const hash = hashCode(content);
    const cache = this.bypassCache.get(relPath) || [
      { date: 0, hash: -1 },
      { date: 0, hash: -1 },
    ];

    if (action === 'push') {
      cache[0] = { date, hash };
      if (cache[1].hash === -1) cache[1] = { date, hash };
    } else if (action === 'pull') {
      cache[1] = { date, hash };
      if (cache[0].hash === -1) cache[0] = { date, hash };
    } else {
      cache[0] = { date, hash };
      cache[1] = { date, hash };
    }

    this.bypassCache.set(relPath, cache);
  }

  /**
   * Checks if change should propagate (reference: Overleaf-Workshop).
   */
  private shouldPropagate(
    action: 'push' | 'pull',
    relPath: string,
    content?: Buffer | string
  ): boolean {
    const now = Date.now();
    const cache = this.bypassCache.get(relPath);

    if (cache) {
      const thisHash = hashCode(content);

      // If content same, skip
      if (action === 'push' && cache[0].hash === thisHash) return false;
      if (action === 'pull' && cache[1].hash === thisHash) return false;

      // If contents differ on both sides, check time window
      if (cache[0].hash !== cache[1].hash) {
        if (
          (action === 'push' && now - cache[0].date < this.bypassWindow) ||
          (action === 'pull' && now - cache[1].date < this.bypassWindow)
        ) {
          this.setBypassCache(relPath, content, action);
          return true;
        }
        this.setBypassCache(relPath, content, action);
        return false;
      }
    }

    this.setBypassCache(relPath, content, action);
    return true;
  }

  // ====== Private Methods ======

  /**
   * Checks if path should be ignored.
   */
  private shouldIgnore(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of this.ignorePatterns) {
      if (minimatch(normalizedPath, pattern, { dot: true })) {
        return true;
      }
    }

    return false;
  }

  /**
   * Recursively collects remote files.
   */
  private collectFiles(
    folder: FolderEntity,
    currentPath: string,
    result: Array<{ path: string; id: string; type: 'doc' | 'file' }>
  ): void {
    // Collect documents
    if (folder.docs) {
      for (const doc of folder.docs) {
        const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name;
        result.push({ path: docPath, id: doc._id, type: 'doc' });
      }
    }

    // Collect binary files
    if (folder.fileRefs) {
      for (const file of folder.fileRefs) {
        const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
        result.push({ path: filePath, id: file._id, type: 'file' });
      }
    }

    // Recursively process subfolders
    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const folderPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
        this.collectFiles(subFolder, folderPath, result);
      }
    }
  }

  /**
   * Recursively collects remote folders (for creating empty directories).
   */
  private collectFolders(folder: FolderEntity, currentPath: string, result: string[]): void {
    if (currentPath) {
      result.push(currentPath);
    }

    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const folderPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
        this.collectFolders(subFolder, folderPath, result);
      }
    }
  }

  /**
   * Builds entityId → path mapping cache.
   *
   * Called during syncFromRemote, used for subsequent delete/rename/move event handling.
   */
  private buildEntityPathCache(folder: FolderEntity, currentPath: string): void {
    // Cache current folder (root uses empty path)
    this.entityPathCache.set(folder._id, currentPath);

    // Cache documents
    if (folder.docs) {
      for (const doc of folder.docs) {
        const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name;
        this.entityPathCache.set(doc._id, docPath);
      }
    }

    // Cache binary files
    if (folder.fileRefs) {
      for (const file of folder.fileRefs) {
        const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
        this.entityPathCache.set(file._id, filePath);
      }
    }

    // Recursively process subfolders
    if (folder.folders) {
      for (const subFolder of folder.folders) {
        const folderPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
        this.buildEntityPathCache(subFolder, folderPath);
      }
    }
  }

  /**
   * Recursively collects local files.
   */
  private async collectLocalFiles(
    basePath: string,
    relativePath: string,
    result: string[]
  ): Promise<void> {
    const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.collectLocalFiles(basePath, entryRelativePath, result);
      } else if (entry.isFile()) {
        result.push(entryRelativePath);
      }
    }
  }

  /**
   * Recursively collects local folders.
   */
  private async collectLocalFolders(
    basePath: string,
    relativePath: string,
    result: string[]
  ): Promise<void> {
    const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        result.push(entryRelativePath);
        await this.collectLocalFolders(basePath, entryRelativePath, result);
      }
    }
  }

  /**
   * Uploads single file to remote.
   */
  private async uploadFile(
    relativePath: string,
    _rootFolderId: string,
    rootFolder: FolderEntity
  ): Promise<void> {
    if (!this.config) throw new Error('Not initialized');

    const normalizedPath = this.normalizeRelativePath(relativePath);
    const localPath = path.join(this.config.localPath, normalizedPath);
    const pathParts = normalizedPath.split('/');
    const fileName = pathParts.pop()!;
    const parentPath = pathParts.join('/');

    // Find or create parent folder
    let parentFolderId = rootFolder._id;
    if (parentPath) {
      const resolvedFolderId = await this.overleafFileSystem.resolveFolderIdByPath(
        this.config.projectId,
        parentPath
      );

      if (resolvedFolderId) {
        parentFolderId = resolvedFolderId;
      } else {
        // Need to create parent folder (recursively)
        parentFolderId = await this.ensureRemoteFolder(parentPath, rootFolder);
      }
    }

    // Read local file content
    const content = await fs.readFile(localPath);

    // Update cache
    const relPath = `/${relativePath}`;
    this.setBypassCache(relPath, content, 'push');
    this.baseCache.set(relPath, content);

    // Determine if text or binary
    const isText = this.isTextFile(fileName);

    if (isText) {
      // Check if file already exists on remote
      const existing = await this.overleafFileSystem.getDocByPath(
        this.config.projectId,
        normalizedPath
      );

      if (existing) {
        // Update existing document
        const updateResult = await this.overleafFileSystem.updateDoc(
          this.config.projectId,
          existing.docId,
          content.toString('utf-8')
        );
        if (!updateResult.success) {
          throw new Error(`Failed to update remote document: ${relativePath}`);
        }
      } else {
        // Create new document
        const createResult = await this.overleafFileSystem.createDoc(
          this.config.projectId,
          parentFolderId,
          fileName,
          content.toString('utf-8')
        );
        if (!createResult.success) {
          // Fallback: if same-name doc exists on remote (maybe due to concurrency/delay), try update
          const fallbackEntity = await this.overleafFileSystem.resolvePathToEntity(
            this.config.projectId,
            normalizedPath
          );
          if (fallbackEntity && fallbackEntity.type === 'doc') {
            const updateResult = await this.overleafFileSystem.updateDoc(
              this.config.projectId,
              fallbackEntity.id,
              content.toString('utf-8')
            );
            if (updateResult.success) {
              return;
            }
          }
          throw new Error(
            createResult.error || `Failed to create remote document: ${relativePath}`
          );
        }
      }
    } else {
      // Binary file
      const uploadResult = await this.overleafFileSystem.uploadFile(
        this.config.projectId,
        parentFolderId,
        fileName,
        content
      );
      if (!uploadResult.success) {
        throw new Error(uploadResult.error || `Failed to upload binary file: ${relativePath}`);
      }
    }
  }

  /**
   * Ensures remote folder exists, creates if not.
   *
   * Fix: Uses level-by-level path lookup, correctly handles nested directories (e.g., a/b/c).
   */
  private async ensureRemoteFolder(folderPath: string, rootFolder: FolderEntity): Promise<string> {
    if (!this.config) throw new Error('Not initialized');

    const normalizedPath = this.normalizeRelativePath(folderPath);
    const parts = normalizedPath.split('/').filter((p) => p.length > 0);

    if (parts.length === 0) {
      return rootFolder._id;
    }

    let currentFolderId = rootFolder._id;
    const currentPathParts: string[] = [];

    for (const part of parts) {
      currentPathParts.push(part);
      const currentPath = currentPathParts.join('/');

      // Use full path to find existing folder (correctly handles nested directories)
      const existingId = await this.overleafFileSystem.resolveFolderIdByPath(
        this.config.projectId,
        currentPath
      );

      if (existingId) {
        currentFolderId = existingId;
      } else {
        // Create folder
        const result = await this.overleafFileSystem.createFolder(
          this.config.projectId,
          currentFolderId,
          part
        );

        if (!result.success || !result.folderId) {
          throw new Error(`Unable to create folder: ${part}`);
        }

        currentFolderId = result.folderId;
        logger.info(`Created remote folder: ${currentPath} -> ${currentFolderId}`);
      }
    }

    return currentFolderId;
  }

  /**
   * Determines if file is text file.
   */
  private isTextFile(fileName: string): boolean {
    const textExtensions = [
      '.tex',
      '.txt',
      '.md',
      '.bib',
      '.cls',
      '.sty',
      '.bst',
      '.json',
      '.xml',
      '.yaml',
      '.yml',
      '.toml',
      '.typ',
      '.typst',
      '.css',
      '.js',
      '.ts',
      '.html',
      '.htm',
      '.py',
      '.r',
      '.m',
      '.sh',
      '.bat',
      '.gitignore',
      '.editorconfig',
    ];

    const ext = path.extname(fileName).toLowerCase();
    return textExtensions.includes(ext) || !ext; // No extension also treated as text
  }

  /**
   * Normalizes relative path to POSIX style.
   *
   * - Unifies separator to /
   * - Resolves . and .. path segments
   * - Removes leading ./
   * - Merges duplicate /
   */
  private normalizeRelativePath(filePath: string): string {
    // Use path.posix.normalize to normalize (handles ./ and ..)
    // First convert Windows separators to POSIX
    const posixPath = filePath.replace(/\\/g, '/');
    let normalized = path.posix.normalize(posixPath);

    // Remove leading ./ (path.posix.normalize preserves single ./)
    if (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }

    return normalized;
  }

  /**
   * Saves configuration to ConfigManager.
   */
  private saveConfig(): void {
    if (this.config) {
      configManager.set(CONFIG_KEY, this.config);
      logger.info('Local Replica config saved');
    }
  }

  /**
   * Loads configuration from ConfigManager.
   */
  private loadSavedConfig(): void {
    const saved = configManager.get<LocalReplicaConfig>(CONFIG_KEY);
    if (saved) {
      this.config = saved;
      this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(saved.customIgnorePatterns || [])];
      logger.info(`Loaded saved Local Replica config: ${saved.projectName}`);
    }
  }

  // ====== Lifecycle ======

  dispose(): void {
    this.stopWatching();
    this.removeAllListeners();
    this.bypassCache.clear();
    this.baseCache.clear();
    logger.info('LocalReplicaService disposed');
  }
}

// ====== Internal Types ======

interface FolderEntity {
  _id: string;
  name: string;
  docs?: Array<{ _id: string; name: string }>;
  fileRefs?: Array<{ _id: string; name: string }>;
  folders?: FolderEntity[];
}

// ====== Factory Function ======

export function createLocalReplicaService(
  overleafService: IOverleafService,
  overleafFileSystem: IOverleafFileSystemService,
  fileSystemService?: IFileSystemService
): LocalReplicaService {
  const service = new LocalReplicaService(overleafService, overleafFileSystem);
  if (fileSystemService) {
    service.setFileSystemService(fileSystemService);
  }
  return service;
}
