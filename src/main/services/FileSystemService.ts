/**
 * @file FileSystemService - File system operations service
 * @description Uses FileWorkerClient to run operations in separate thread,
 *              avoiding main process blocking during large directory scans and file watching.
 * @implements IFileSystemService for ServiceContainer injection
 */

import { EventEmitter } from 'events';
import path from 'path';
import {
  type FileChangeEvent,
  type FileNode,
  type FileWorkerClient,
  getFileWorkerClient,
} from '../workers/FileWorkerClient';
import { getFileCacheService } from './FileCacheService';
import { createLogger } from './LoggerService';
import type { IFileSystemService } from './interfaces';
import fs from './knowledge/utils/fsCompat';

const logger = createLogger('FileSystemService');

/**
 * @remarks Re-exported worker types for consumer convenience.
 */
export type { FileNode, FileChangeEvent };

/** Timeout for rename detection (ms) */
const RENAME_DETECTION_TIMEOUT_MS = 500;

/** Deleted file record for rename detection */
interface DeletedFileRecord {
  path: string;
  dirPath: string;
  filename: string;
  mtime: number | undefined;
  timestamp: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * @remarks Offloads file IO to a worker and manages watcher lifecycle.
 * @sideeffect Registers file watchers and emits file change events.
 */
export class FileSystemService extends EventEmitter implements IFileSystemService {
  // ====== State ======
  private workerClient: FileWorkerClient;
  private watchedPath: string | null = null;
  // Keys normalized via normalizeCachePath for consistent cache lookup
  private fileMtimeCache: Map<string, number> = new Map();
  private currentScanAbortId: string | null = null;
  private currentScanPath: string | null = null;
  private currentScanPromise: Promise<FileNode> | null = null;
  // For rename detection: key = `${normalizedDirPath}:${filename.length}`
  private recentlyDeleted: Map<string, DeletedFileRecord> = new Map();

  /**
   * Normalize path for cache key consistency across different sources
   * (Watcher, IPC, internal calls). Windows paths are lowercased since
   * Windows filesystem is case-insensitive.
   */
  private normalizeCachePath(filePath: string): string {
    let normalized = path.normalize(filePath);
    if (process.platform === 'win32') {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  // Only exclude essential directories/system files, avoid filtering user files by extension
  private ignorePatterns = [
    '.git',
    '.svn',
    '.hg',
    'node_modules',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
  ];

  constructor() {
    super();
    this.workerClient = getFileWorkerClient();
    this.setupWorkerEventListeners();
  }

  // ====== File Operations ======

  /**
   * Read file content.
   * @security No path validation - caller must ensure path is verified via PathSecurityService
   */
  async readFile(filePath: string): Promise<{ content: string; mtime?: number }> {
    const content = await fs.readFile(filePath, 'utf-8');
    try {
      const stats = await fs.stat(filePath);
      return { content, mtime: stats.mtimeMs };
    } catch {
      return { content };
    }
  }

  /**
   * Write file content with atomic write (temp file + rename).
   * @security No path validation - caller must ensure path is verified
   */
  async writeFile(
    filePath: string,
    content: string,
    options?: { ensureDir?: boolean }
  ): Promise<void> {
    if (options?.ensureDir) {
      await fs.ensureDir(path.dirname(filePath));
    }

    const tempPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);

    try {
      const stats = await fs.stat(filePath);
      this.updateFileMtime(filePath, stats.mtimeMs);
    } catch {
      // Ignore stat errors
    }

    logger.info(`[FileSystemService] File written: ${filePath}`);
  }

  /**
   * Delete file.
   * @security No path validation - caller must ensure path is verified
   */
  async deleteFile(filePath: string): Promise<void> {
    await fs.remove(filePath);

    const normalizedPath = this.normalizeCachePath(filePath);
    this.fileMtimeCache.delete(normalizedPath);

    logger.info(`[FileSystemService] File deleted: ${filePath}`);
  }

  /** Setup worker event listeners */
  private setupWorkerEventListeners(): void {
    this.workerClient.on('file-changed', (event: FileChangeEvent) => {
      this.handleFileChange(event);
    });

    this.workerClient.on('watcher-error', (error: { message: string }) => {
      console.error('[FileSystemService] Watcher error:', error.message);
    });

    this.workerClient.on('error', (error: Error) => {
      console.error('[FileSystemService] Worker error:', error);
    });
  }

  /**
   * Handle file change events with rename detection.
   * Detects renames by correlating unlink + add events in same directory.
   */
  private handleFileChange(event: FileChangeEvent): void {
    const { type, path: filePath, mtime } = event;
    const normalizedPath = this.normalizeCachePath(filePath);

    switch (type) {
      case 'change':
        const cachedMtime = this.fileMtimeCache.get(normalizedPath);
        if (cachedMtime !== undefined && mtime && Math.abs(mtime - cachedMtime) > 100) {
          logger.info('[FileSystemService] External change detected:', filePath);
          getFileCacheService().invalidate(filePath);
          this.emit('file-changed', event);
        }
        if (mtime) {
          this.fileMtimeCache.set(normalizedPath, mtime);
        }
        break;

      case 'unlink':
        this.handleUnlink(filePath, mtime);
        break;

      case 'add':
        this.handleAdd(filePath, mtime);
        break;
    }
  }

  /** Handle file unlink with rename detection */
  private handleUnlink(filePath: string, mtime: number | undefined): void {
    const normalizedPath = this.normalizeCachePath(filePath);
    const normalizedDirPath = this.normalizeCachePath(path.dirname(filePath));
    const filename = path.basename(filePath);
    const key = `${normalizedDirPath}:${filename.length}`;

    const existing = this.recentlyDeleted.get(key);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    // After timeout, confirm it's a delete not rename
    const timeoutId = setTimeout(() => {
      this.recentlyDeleted.delete(key);

      logger.info('[FileSystemService] File deleted:', filePath);
      this.fileMtimeCache.delete(normalizedPath);
      getFileCacheService().invalidate(filePath);
      this.emit('file-changed', { type: 'unlink', path: filePath });
    }, RENAME_DETECTION_TIMEOUT_MS);

    this.recentlyDeleted.set(key, {
      path: filePath,
      dirPath: normalizedDirPath,
      filename,
      mtime,
      timestamp: Date.now(),
      timeoutId,
    });
  }

  /** Handle file add with rename detection */
  private handleAdd(filePath: string, mtime: number | undefined): void {
    const normalizedPath = this.normalizeCachePath(filePath);
    const normalizedDirPath = this.normalizeCachePath(path.dirname(filePath));
    const filename = path.basename(filePath);
    const key = `${normalizedDirPath}:${filename.length}`;
    const deletedRecord = this.recentlyDeleted.get(key);

    if (deletedRecord && Date.now() - deletedRecord.timestamp < RENAME_DETECTION_TIMEOUT_MS) {
      // Likely a rename operation
      clearTimeout(deletedRecord.timeoutId);
      this.recentlyDeleted.delete(key);

      const oldPath = deletedRecord.path;
      const oldNormalizedPath = this.normalizeCachePath(oldPath);
      const newPath = filePath;

      logger.info(`[FileSystemService] Rename detected: ${oldPath} -> ${newPath}`);

      this.fileMtimeCache.delete(oldNormalizedPath);
      if (mtime) {
        this.fileMtimeCache.set(normalizedPath, mtime);
      }

      getFileCacheService().invalidate(oldPath);
      this.emit('file-renamed', { oldPath, newPath, mtime });
      // Backward compatible events
      this.emit('file-changed', { type: 'unlink', path: oldPath });
      this.emit('file-changed', { type: 'add', path: newPath, mtime });
    } else {
      if (mtime) {
        this.fileMtimeCache.set(normalizedPath, mtime);
      }
      this.emit('file-changed', { type: 'add', path: filePath, mtime });
    }
  }

  /**
   * Build file tree structure from directory using Worker.
   * Handles race conditions when rapidly opening projects by retry mechanism.
   */
  async buildFileTree(dirPath: string): Promise<FileNode> {
    const normalizedPath = this.normalizeCachePath(dirPath);

    if (this.currentScanPromise && this.currentScanPath === normalizedPath) {
      return this.currentScanPromise;
    }

    const scanPromise = (async () => {
      const previousAbortId = this.currentScanAbortId;
      if (previousAbortId) {
        await this.workerClient.abortScan(previousAbortId);
        // Allow previous scan to cleanup
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const abortId = `scan-${Date.now()}`;
      this.currentScanAbortId = abortId;

      const maxRetries = 3;
      let lastError: Error | null = null;

      try {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            if (this.currentScanAbortId !== abortId) {
              throw new Error('Scan superseded by newer request');
            }

            const result = await this.workerClient.scanDirectory(
              dirPath,
              this.ignorePatterns,
              abortId
            );

            return result;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (lastError.message === 'Scan superseded by newer request') {
              throw lastError;
            }

            // "Scan aborted" may be leftover from previous scan, retry with backoff
            if (lastError.message === 'Scan aborted' && attempt < maxRetries - 1) {
              logger.warn(
                `[FileSystemService] Scan aborted (attempt ${attempt + 1}/${maxRetries}), retrying...`
              );
              await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
              continue;
            }

            throw lastError;
          }
        }

        throw lastError || new Error('Failed to scan directory');
      } finally {
        if (this.currentScanAbortId === abortId) {
          this.currentScanAbortId = null;
        }
      }
    })();

    this.currentScanPromise = scanPromise;
    this.currentScanPath = normalizedPath;

    try {
      return await scanPromise;
    } finally {
      if (this.currentScanPromise === scanPromise) {
        this.currentScanPromise = null;
        this.currentScanPath = null;
      }
    }
  }

  /** Start watching project directory using Worker */
  async startWatching(dirPath: string): Promise<void> {
    const normalizedDirPath = this.normalizeCachePath(dirPath);
    const normalizedWatchedPath = this.watchedPath
      ? this.normalizeCachePath(this.watchedPath)
      : null;

    if (normalizedWatchedPath === normalizedDirPath) {
      logger.info('[FileSystemService] Already watching:', dirPath);
      return;
    }

    await this.stopWatching();

    logger.info('[FileSystemService] Starting to watch:', dirPath);
    this.watchedPath = dirPath;

    await this.workerClient.startWatching(dirPath, this.ignorePatterns);
  }

  /** Stop directory watching */
  async stopWatching(): Promise<void> {
    if (this.watchedPath) {
      logger.info('[FileSystemService] Stopping watcher');
      await this.workerClient.stopWatching();
      this.watchedPath = null;
      this.fileMtimeCache.clear();

      for (const record of this.recentlyDeleted.values()) {
        clearTimeout(record.timeoutId);
      }
      this.recentlyDeleted.clear();
    }
  }

  /**
   * Resolve directory children (lazy loading).
   * Core method for lazy-load strategy to avoid loading entire tree at once.
   */
  async resolveChildren(dirPath: string): Promise<FileNode[]> {
    logger.debug('[FileSystemService] Resolving children for:', dirPath);
    return this.workerClient.resolveChildren(dirPath, this.ignorePatterns);
  }

  /**
   * Scan all file paths (flat list for @ completion index).
   * Returns paths only (no tree structure) - faster and lower memory.
   */
  async scanFilePaths(projectPath: string): Promise<string[]> {
    logger.debug('[FileSystemService] Scanning file paths for:', projectPath);

    try {
      const paths = await this.workerClient.scanFilePaths(projectPath, this.ignorePatterns);
      logger.debug(`[FileSystemService] Scanned ${paths.length} file paths`);
      return paths;
    } catch (error) {
      logger.error('[FileSystemService] Failed to scan file paths:', error);
      throw error;
    }
  }

  /** Record file mtime (called on read/save) */
  async recordFileMtime(filePath: string): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      const normalizedPath = this.normalizeCachePath(filePath);
      this.fileMtimeCache.set(normalizedPath, stats.mtimeMs);
    } catch {
      // File may not exist
    }
  }

  /** Update mtime cache (called after save) */
  updateFileMtime(filePath: string, mtime: number): void {
    const normalizedPath = this.normalizeCachePath(filePath);
    this.fileMtimeCache.set(normalizedPath, mtime);
  }

  /** Get cached mtime */
  getCachedMtime(filePath: string): number | undefined {
    const normalizedPath = this.normalizeCachePath(filePath);
    return this.fileMtimeCache.get(normalizedPath);
  }

  /**
   * Get file extension
   */
  getFileExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase().slice(1);
  }

  /**
   * Check if file is a LaTeX file
   */
  isLaTeXFile(filePath: string): boolean {
    const ext = this.getFileExtension(filePath);
    return ['tex', 'latex', 'ltx', 'sty', 'cls', 'bib'].includes(ext);
  }

  /** Find main TeX file in project (using Worker) */
  async findMainTexFile(projectPath: string): Promise<string | null> {
    const files = await this.workerClient.findFiles(projectPath, '.tex', this.ignorePatterns);

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (content.includes('\\documentclass')) {
          return file;
        }
      } catch {
        // Ignore read errors
      }
    }

    return files[0] || null;
  }

  /** Find all files with specific extension (using Worker) */
  async findFiles(dirPath: string, extension: string): Promise<string[]> {
    return this.workerClient.findFiles(dirPath, extension, this.ignorePatterns);
  }
}

/**
 * @remarks Returns a new instance for ServiceContainer registration.
 */
export function createFileSystemService(): IFileSystemService {
  return new FileSystemService();
}
