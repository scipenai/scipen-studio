/**
 * @file IFileSystemService - File system service contract
 * @description Public interface for file tree scanning and file watching
 * @depends FileSystemService
 * @note Single-file read/write is handled in fileHandlers.ts via fs
 */

import type { EventEmitter } from 'events';

// ====== Type Definitions ======

/**
 * File node in tree representation.
 */
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  mtime?: number;
}

/**
 * File change event emitted by watcher.
 */
export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'rename';
  path: string;
  oldPath?: string; // Used for rename events.
  mtime?: number;
}

// ====== Interface Definitions ======

/**
 * File read result payload.
 */
export interface FileReadResult {
  content: string;
  mtime?: number;
}

/**
 * File system service interface.
 */
export interface IFileSystemService extends EventEmitter {
  // ====== File I/O ======

  /**
   * Reads file content.
   * @param filePath File path
   * @returns Content and mtime
   */
  readFile(filePath: string): Promise<FileReadResult>;

  /**
   * Writes file content.
   * @param filePath File path
   * @param content File content
   * @param options Write options
   * @sideeffect Writes to disk and may create directories
   */
  writeFile(filePath: string, content: string, options?: { ensureDir?: boolean }): Promise<void>;

  /**
   * Deletes a file.
   * @param filePath File path
   * @sideeffect Removes file from disk
   */
  deleteFile(filePath: string): Promise<void>;

  // ====== Directory Scanning ======

  /**
   * Builds a file tree for a directory.
   * @param dirPath Directory path
   * @returns File tree root node
   */
  buildFileTree(dirPath: string): Promise<FileNode>;

  /**
   * Lazily resolves child entries for a directory.
   * @param dirPath Directory path
   * @returns Child entries
   */
  resolveChildren(dirPath: string): Promise<FileNode[]>;

  /**
   * Scans all file paths as a flat list (used for @ autocomplete).
   * @param projectPath Project root path
   * @returns Flat list of file paths
   */
  scanFilePaths(projectPath: string): Promise<string[]>;

  // ====== Watching ======

  /**
   * Starts watching a directory for changes.
   * @param dirPath Directory path to watch
   * @sideeffect Emits file-changed events
   */
  startWatching(dirPath: string): Promise<void>;

  /**
   * Stops watching.
   */
  stopWatching(): Promise<void>;

  // ====== mtime Cache ======

  /**
   * Records file mtime.
   * @param filePath File path
   */
  recordFileMtime(filePath: string): Promise<void>;

  /**
   * Updates mtime cache.
   * @param filePath File path
   * @param mtime Modified time
   */
  updateFileMtime(filePath: string, mtime: number): void;

  /**
   * Returns cached mtime.
   * @param filePath File path
   */
  getCachedMtime(filePath: string): number | undefined;

  // ====== Helpers ======

  /**
   * Gets file extension.
   * @param filePath File path
   */
  getFileExtension(filePath: string): string;

  /**
   * Checks whether path is a LaTeX file.
   * @param filePath File path
   */
  isLaTeXFile(filePath: string): boolean;

  /**
   * Finds the main TeX file within a project.
   * @param projectPath Project path
   */
  findMainTexFile(projectPath: string): Promise<string | null>;

  /**
   * Finds files matching a specific extension.
   * @param dirPath Directory path
   * @param extension Extension (including dot)
   */
  findFiles(dirPath: string, extension: string): Promise<string[]>;

  // ====== Events (EventEmitter) ======

  /**
   * Subscribes to file change events.
   */
  on(event: 'file-changed', listener: (event: FileChangeEvent) => void): this;

  /**
   * Subscribes to scan progress events.
   */
  on(event: 'scan-progress', listener: (data: { scanned: number; total: number }) => void): this;
}
