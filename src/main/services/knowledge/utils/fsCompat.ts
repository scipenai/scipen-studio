/**
 * @file fsCompat - fs-extra Compatibility Layer
 * @description Uses native Node.js fs module, resolves fs-extra ESM issues in packaged Electron apps
 * @depends node:fs, node:fs/promises
 */

import * as nodeFs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';

// ====== Directory Operations ======

/**
 * Ensure directory exists (recursively create)
 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Ensure directory exists (synchronous, recursively create)
 */
export function ensureDirSync(dir: string): void {
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

// ====== Path Operations ======

/**
 * Check if path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronously check if path exists
 */
export function pathExistsSync(filePath: string): boolean {
  return nodeFs.existsSync(filePath);
}

// ====== File Status ======

/**
 * Get file status
 */
export function stat(filePath: string): Promise<nodeFs.Stats> {
  return fsPromises.stat(filePath);
}

/**
 * Synchronously get file status
 */
export function statSync(filePath: string): nodeFs.Stats {
  return nodeFs.statSync(filePath);
}

// ====== File Copy ======

/**
 * Copy file
 */
export async function copy(
  src: string,
  dest: string,
  options?: { overwrite?: boolean }
): Promise<void> {
  const mode = options?.overwrite === false ? nodeFs.constants.COPYFILE_EXCL : 0;
  await fsPromises.copyFile(src, dest, mode);
}

// ====== File Write Operations ======

/**
 * Write file
 */
export function writeFile(
  filePath: string,
  data: string | Buffer,
  options?: nodeFs.WriteFileOptions
): Promise<void> {
  return fsPromises.writeFile(filePath, data, options);
}

/**
 * Atomic file write (write temp file -> rename)
 *
 * Uses "write-temp-rename" pattern to ensure atomic write operations:
 * - If crash/power loss occurs during write, original file remains unchanged
 * - Prevents Watcher from observing incomplete intermediate states
 *
 * @param filePath Target file path
 * @param data File content
 * @param options Write options
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options?: nodeFs.WriteFileOptions
): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    // 1. Write to temporary file
    await fsPromises.writeFile(tempPath, data, options);

    // 2. Atomic rename (atomic operation on same filesystem)
    await fsPromises.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temporary file (if exists)
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Append to file
 */
export function appendFile(
  filePath: string,
  data: string | Buffer,
  options?: nodeFs.WriteFileOptions
): Promise<void> {
  return fsPromises.appendFile(filePath, data, options);
}

// ====== File Read Operations ======

/**
 * Read file (async)
 */
export function readFile(filePath: string): Promise<Buffer>;
export function readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
export function readFile(filePath: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  if (encoding) {
    return fsPromises.readFile(filePath, encoding);
  }
  return fsPromises.readFile(filePath);
}

/**
 * Synchronously read file
 */
export function readFileSync(filePath: string): Buffer;
export function readFileSync(filePath: string, encoding: BufferEncoding): string;
export function readFileSync(filePath: string, encoding?: BufferEncoding): Buffer | string {
  if (encoding) {
    return nodeFs.readFileSync(filePath, encoding);
  }
  return nodeFs.readFileSync(filePath);
}

// ====== File Delete Operations ======

/**
 * Remove file or directory
 */
export async function remove(filePath: string): Promise<void> {
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.isDirectory()) {
      await fsPromises.rm(filePath, { recursive: true, force: true });
    } else {
      await fsPromises.unlink(filePath);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// ====== JSON Operations ======

/**
 * Read JSON file (async)
 */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const content = await fsPromises.readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Read JSON file (synchronous)
 */
export function readJsonSync<T = unknown>(filePath: string): T {
  const content = nodeFs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Write JSON file (async)
 */
export async function writeJson(
  filePath: string,
  data: unknown,
  options?: { spaces?: number }
): Promise<void> {
  const content = JSON.stringify(data, null, options?.spaces ?? 2);
  await fsPromises.writeFile(filePath, content, 'utf-8');
}

/**
 * Write JSON file (synchronous)
 */
export function writeJsonSync(
  filePath: string,
  data: unknown,
  options?: { spaces?: number }
): void {
  const content = JSON.stringify(data, null, options?.spaces ?? 2);
  nodeFs.writeFileSync(filePath, content, 'utf-8');
}

// ====== Directory Read Operations ======

/**
 * Read directory contents (async)
 */
export async function readdir(dirPath: string): Promise<string[]>;
export async function readdir(
  dirPath: string,
  options: { withFileTypes: true }
): Promise<nodeFs.Dirent[]>;
export async function readdir(
  dirPath: string,
  options?: { withFileTypes?: boolean }
): Promise<string[] | nodeFs.Dirent[]> {
  if (options?.withFileTypes) {
    return fsPromises.readdir(dirPath, { withFileTypes: true });
  }
  return fsPromises.readdir(dirPath) as Promise<string[]>;
}

/**
 * Read directory contents (synchronous)
 */
export function readdirSync(dirPath: string, options?: { withFileTypes: true }): nodeFs.Dirent[];
export function readdirSync(dirPath: string): string[];
export function readdirSync(
  dirPath: string,
  options?: { withFileTypes?: boolean }
): string[] | nodeFs.Dirent[] {
  if (options?.withFileTypes) {
    return nodeFs.readdirSync(dirPath, { withFileTypes: true });
  }
  return nodeFs.readdirSync(dirPath);
}

// ====== Stream Operations ======

/**
 * Create write stream
 */
export function createWriteStream(filePath: string): nodeFs.WriteStream {
  return nodeFs.createWriteStream(filePath);
}

/**
 * Create read stream
 */
export function createReadStream(filePath: string): nodeFs.ReadStream {
  return nodeFs.createReadStream(filePath);
}

// ====== File Watching ======

/**
 * Watch file
 */
export function watch(
  filename: string,
  options?: { recursive?: boolean; persistent?: boolean; encoding?: BufferEncoding },
  listener?: (event: nodeFs.WatchEventType, filename: string | null) => void
): nodeFs.FSWatcher {
  if (listener) {
    return nodeFs.watch(filename, options ?? {}, listener);
  }
  return nodeFs.watch(filename, options ?? {});
}

// ====== File Move/Rename Operations ======

/**
 * Rename/move file
 */
export async function rename(oldPath: string, newPath: string): Promise<void> {
  await fsPromises.rename(oldPath, newPath);
}

/**
 * Synchronously rename/move file
 */
export function renameSync(oldPath: string, newPath: string): void {
  nodeFs.renameSync(oldPath, newPath);
}

/**
 * Move file (copy then delete)
 */
export async function move(
  src: string,
  dest: string,
  options?: { overwrite?: boolean }
): Promise<void> {
  if (options?.overwrite === false) {
    try {
      await fsPromises.access(dest);
      throw new Error(`Destination already exists: ${dest}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  // Try using rename (faster), use copy+unlink if cross-device
  try {
    await fsPromises.rename(src, dest);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device, use copy
      await fsPromises.copyFile(src, dest);
      await fsPromises.unlink(src);
    } else {
      throw error;
    }
  }
}

// ====== File Utilities ======

/**
 * Ensure file exists (create empty file if not exists)
 */
export async function ensureFile(filePath: string): Promise<void> {
  try {
    await fsPromises.access(filePath);
  } catch {
    // Ensure directory exists
    const dir = nodePath.dirname(filePath);
    await ensureDir(dir);
    // Create empty file
    await fsPromises.writeFile(filePath, '');
  }
}

// ====== Type Exports ======

export type FSWatcher = nodeFs.FSWatcher;

// ====== Default Export ======

// Default export for easy fs-extra import replacement
export default {
  ensureDir,
  ensureDirSync,
  ensureFile,
  pathExists,
  pathExistsSync,
  stat,
  statSync,
  copy,
  writeFile,
  writeFileAtomic,
  appendFile,
  readFile,
  readFileSync,
  remove,
  rename,
  renameSync,
  move,
  readJson,
  readJsonSync,
  writeJson,
  writeJsonSync,
  readdir,
  readdirSync,
  createWriteStream,
  createReadStream,
  watch,
  existsSync: nodeFs.existsSync,
  unlinkSync: nodeFs.unlinkSync,
};
