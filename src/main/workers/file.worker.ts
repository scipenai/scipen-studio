/**
 * @file File System Worker
 * @description Performs file system operations in a separate thread to avoid blocking main process.
 * @features Recursive directory scanning, file watching (@parcel/watcher), event throttling.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parentPort } from 'worker_threads';

const isDev = process.env.NODE_ENV === 'development';
const log = {
  debug: (...args: unknown[]) => isDev && console.debug('[FileWorker]', ...args),
  info: (...args: unknown[]) => isDev && console.info('[FileWorker]', ...args),
  warn: (...args: unknown[]) => console.warn('[FileWorker]', ...args),
  error: (...args: unknown[]) => console.error('[FileWorker]', ...args),
};

// High-performance native file watcher (same as VS Code)
import type { AsyncSubscription, Event as ParcelEvent } from '@parcel/watcher';
let parcelWatcher: typeof import('@parcel/watcher') | null = null;

async function getParcelWatcher() {
  if (!parcelWatcher) {
    parcelWatcher = await import('@parcel/watcher');
  }
  return parcelWatcher;
}

// ============ Type Definitions ============

type PingPayload = Record<string, never>;

interface ScanDirectoryPayload {
  dirPath: string;
  ignorePatterns?: string[];
  abortId?: string;
  depth?: number;
}

interface ResolveChildrenPayload {
  dirPath: string;
  ignorePatterns?: string[];
}

interface ScanFilePathsPayload {
  dirPath: string;
  ignorePatterns?: string[];
  abortId?: string;
}

interface StartWatchingPayload {
  dirPath: string;
  ignorePatterns?: string[];
}

type StopWatchingPayload = Record<string, never>;

interface FindFilesPayload {
  dirPath: string;
  extension: string;
  ignorePatterns?: string[];
}

interface AbortPayload {
  abortId: string;
}

type WorkerMessage =
  | { id: string; type: 'ping'; payload: PingPayload }
  | { id: string; type: 'scanDirectory'; payload: ScanDirectoryPayload }
  | { id: string; type: 'resolveChildren'; payload: ResolveChildrenPayload }
  | { id: string; type: 'scanFilePaths'; payload: ScanFilePathsPayload }
  | { id: string; type: 'startWatching'; payload: StartWatchingPayload }
  | { id: string; type: 'stopWatching'; payload: StopWatchingPayload }
  | { id: string; type: 'findFiles'; payload: FindFilesPayload }
  | { id: string; type: 'abort'; payload: AbortPayload };

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface WorkerEvent {
  type: 'file-change' | 'watcher-error' | 'scan-progress';
  data: unknown;
}

/**
 * @remarks File tree node used by the renderer and worker APIs.
 */
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  /** Lazy-loading flag: whether children have been resolved */
  isResolved?: boolean;
}

/**
 * @remarks File change event emitted by watcher.
 */
export interface FileChangeEvent {
  type: 'change' | 'unlink' | 'add';
  path: string;
  mtime?: number;
}

// ============ Default Ignore Patterns ============

const DEFAULT_IGNORE_PATTERNS = ['.git', '.svn', 'node_modules', '.DS_Store', 'Thumbs.db'];

// ============ State Management ============

let currentSubscription: AsyncSubscription | null = null;
let currentWatchPath: string | null = null;
let currentIgnorePatterns: string[] = [];
const abortControllers = new Map<string, { aborted: boolean }>();

const eventBuffer: Map<string, FileChangeEvent> = new Map();
let eventFlushTimer: NodeJS.Timeout | null = null;
const EVENT_BUFFER_DELAY = 100; // Event merge window

// ============ Utility Functions ============

function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  const name = path.basename(filePath);

  // Only ignore explicitly specified patterns, not all hidden files
  if (ignorePatterns.includes(name)) {
    return true;
  }

  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (ignorePatterns.includes(part)) {
      return true;
    }
  }

  return false;
}

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage({ ...response, isResponse: true });
}

function sendEvent(event: WorkerEvent): void {
  parentPort?.postMessage({ ...event, isEvent: true });
}

function flushEventBuffer(): void {
  if (eventBuffer.size === 0) return;

  const events = Array.from(eventBuffer.values());
  eventBuffer.clear();

  sendEvent({
    type: 'file-change',
    data: events,
  });
}

/** Later events override earlier ones for the same path (debouncing). */
function bufferEvent(event: FileChangeEvent): void {
  eventBuffer.set(event.path, event);

  if (eventFlushTimer) {
    clearTimeout(eventFlushTimer);
  }
  eventFlushTimer = setTimeout(flushEventBuffer, EVENT_BUFFER_DELAY);
}

// ============ Directory Scanning ============

async function scanDirectory(
  dirPath: string,
  ignorePatterns: string[],
  abortSignal?: { aborted: boolean },
  depth = 1
): Promise<FileNode> {
  const stats = await fs.stat(dirPath);
  const name = path.basename(dirPath);

  if (!stats.isDirectory()) {
    return {
      name,
      path: dirPath,
      type: 'file',
    };
  }

  const children = await readDirectoryWithDepth(dirPath, ignorePatterns, abortSignal, depth, 0);

  return {
    name,
    path: dirPath,
    type: 'directory',
    children,
    isResolved: true,
  };
}

async function readDirectoryWithDepth(
  dirPath: string,
  ignorePatterns: string[],
  abortSignal?: { aborted: boolean },
  maxDepth = 1,
  currentDepth = 0
): Promise<FileNode[]> {
  if (abortSignal?.aborted) {
    throw new Error('Scan aborted');
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (abortSignal?.aborted) {
        throw new Error('Scan aborted');
      }

      if (shouldIgnore(entry.name, ignorePatterns)) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (currentDepth < maxDepth) {
          // Yield thread to avoid long blocking
          await new Promise((resolve) => setTimeout(resolve, 0));

          const children = await readDirectoryWithDepth(
            fullPath,
            ignorePatterns,
            abortSignal,
            maxDepth,
            currentDepth + 1
          );
          nodes.push({
            name: entry.name,
            path: fullPath,
            type: 'directory',
            children,
            isResolved: true,
          });
        } else {
          // Depth limit reached, mark as unresolved for lazy loading
          nodes.push({
            name: entry.name,
            path: fullPath,
            type: 'directory',
            children: [],
            isResolved: false,
          });
        }
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        });
      }
    }

    // Match UI tree ordering: directories first, then files (alphabetical)
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    if ((error as Error).message === 'Scan aborted') {
      throw error;
    }
    log.error(`Failed to read directory ${dirPath}:`, error);
    return [];
  }
}

/** Resolves direct children of a directory (called for lazy loading). */
async function resolveChildren(dirPath: string, ignorePatterns: string[]): Promise<FileNode[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (shouldIgnore(entry.name, ignorePatterns)) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: [],
          isResolved: false,
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    log.error(`Failed to resolve children for ${dirPath}:`, error);
    return [];
  }
}

/**
 * Scans all file paths (flat list for @-mention completion).
 * Lightweight: collects paths only, no tree structure. Faster and less memory than scanDirectory.
 * Directories have trailing separator, files don't.
 */
async function scanFilePaths(
  dirPath: string,
  ignorePatterns: string[],
  abortSignal?: { aborted: boolean }
): Promise<string[]> {
  const paths: string[] = [];
  const sep = path.sep;

  async function scan(dir: string): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error('Scan aborted');
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (abortSignal?.aborted) {
          throw new Error('Scan aborted');
        }

        if (shouldIgnore(entry.name, ignorePatterns)) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isFile()) {
          paths.push(fullPath);
        } else if (entry.isDirectory()) {
          // Trailing separator for frontend type detection
          paths.push(fullPath + sep);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await scan(fullPath);
        }
      }
    } catch (error) {
      if ((error as Error).message === 'Scan aborted') {
        throw error;
      }
      log.debug(`Skipped directory ${dir}:`, error);
    }
  }

  await scan(dirPath);
  return paths;
}

// ============ File Search ============

async function findFiles(
  dirPath: string,
  extension: string,
  ignorePatterns: string[]
): Promise<string[]> {
  const results: string[] = [];

  const scan = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (shouldIgnore(entry.name, ignorePatterns)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        results.push(fullPath);
      }
    }
  };

  await scan(dirPath);
  return results;
}

// ============ File Watching (@parcel/watcher) ============

function mapParcelEventType(type: ParcelEvent['type']): FileChangeEvent['type'] {
  switch (type) {
    case 'create':
      return 'add';
    case 'update':
      return 'change';
    case 'delete':
      return 'unlink';
    default:
      return 'change';
  }
}

async function startWatching(dirPath: string, ignorePatterns: string[]): Promise<void> {
  if (currentWatchPath === dirPath && currentSubscription) {
    log.debug('Already watching:', dirPath);
    return;
  }

  await stopWatching();

  log.info('Starting @parcel/watcher for:', dirPath);
  currentWatchPath = dirPath;
  currentIgnorePatterns = ignorePatterns;

  try {
    const watcher = await getParcelWatcher();

    const ignore = ignorePatterns.map((p) => `**/${p}/**`);

    currentSubscription = await watcher.subscribe(
      dirPath,
      async (err, events) => {
        if (err) {
          log.error('@parcel/watcher error:', err);
          sendEvent({
            type: 'watcher-error',
            data: { message: err.message || 'Unknown watcher error' },
          });
          return;
        }

        for (const event of events) {
          if (shouldIgnore(event.path, currentIgnorePatterns)) {
            continue;
          }

          const eventType = mapParcelEventType(event.type);

          let mtime: number | undefined;
          if (eventType !== 'unlink') {
            try {
              const stats = await fs.stat(event.path);
              mtime = stats.mtimeMs;
            } catch {
              // File may have been deleted
            }
          }

          bufferEvent({
            type: eventType,
            path: event.path,
            mtime,
          });
        }
      },
      {
        ignore,
      }
    );

    log.info('@parcel/watcher started successfully');
  } catch (error) {
    log.error('Failed to start @parcel/watcher:', error);
    sendEvent({
      type: 'watcher-error',
      data: { message: error instanceof Error ? error.message : 'Failed to start watcher' },
    });
  }
}

async function stopWatching(): Promise<void> {
  // Flush remaining events before stopping
  if (eventFlushTimer) {
    clearTimeout(eventFlushTimer);
    eventFlushTimer = null;
  }
  flushEventBuffer();

  if (currentSubscription) {
    log.debug('Stopping @parcel/watcher');
    try {
      await currentSubscription.unsubscribe();
    } catch (error) {
      log.warn('Error unsubscribing watcher:', error);
    }
    currentSubscription = null;
    currentWatchPath = null;
  }
}

// ============ Message Handling ============

async function handleMessage(message: WorkerMessage): Promise<void> {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'ping':
        sendResponse({ id, success: true, data: 'pong' });
        break;

      case 'scanDirectory': {
        const { dirPath, ignorePatterns, abortId, depth } = payload as ScanDirectoryPayload;
        const patterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
        const scanDepth = depth ?? 1;

        let abortSignal: { aborted: boolean } | undefined;
        if (abortId) {
          abortSignal = { aborted: false };
          abortControllers.set(abortId, abortSignal);
        }

        try {
          const result = await scanDirectory(dirPath, patterns, abortSignal, scanDepth);

          if (abortId) {
            abortControllers.delete(abortId);
          }

          sendResponse({ id, success: true, data: result });
        } catch (error) {
          if (abortId) {
            abortControllers.delete(abortId);
          }
          throw error;
        }
        break;
      }

      case 'resolveChildren': {
        const { dirPath, ignorePatterns } = payload as ResolveChildrenPayload;
        const patterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

        const children = await resolveChildren(dirPath, patterns);
        sendResponse({ id, success: true, data: children });
        break;
      }

      case 'scanFilePaths': {
        const { dirPath, ignorePatterns, abortId } = payload as ScanFilePathsPayload;
        const patterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

        let abortSignal: { aborted: boolean } | undefined;
        if (abortId) {
          abortSignal = { aborted: false };
          abortControllers.set(abortId, abortSignal);
        }

        try {
          const paths = await scanFilePaths(dirPath, patterns, abortSignal);

          if (abortId) {
            abortControllers.delete(abortId);
          }

          sendResponse({ id, success: true, data: paths });
        } catch (error) {
          if (abortId) {
            abortControllers.delete(abortId);
          }
          throw error;
        }
        break;
      }

      case 'startWatching': {
        const { dirPath, ignorePatterns } = payload as StartWatchingPayload;
        const patterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
        await startWatching(dirPath, patterns);
        sendResponse({ id, success: true });
        break;
      }

      case 'stopWatching':
        await stopWatching();
        sendResponse({ id, success: true });
        break;

      case 'findFiles': {
        const { dirPath, extension, ignorePatterns } = payload as FindFilesPayload;
        const patterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
        const result = await findFiles(dirPath, extension, patterns);
        sendResponse({ id, success: true, data: result });
        break;
      }

      case 'abort': {
        const { abortId } = payload as { abortId: string };
        const signal = abortControllers.get(abortId);
        if (signal) {
          signal.aborted = true;
          log.debug('Abort signal set for:', abortId);
        }
        sendResponse({ id, success: true });
        break;
      }

      default:
        sendResponse({ id, success: false, error: `Unknown message type: ${type}` });
    }
  } catch (error) {
    log.error(`Error handling message ${type}:`, error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============ Worker Initialization ============

parentPort?.on('message', handleMessage);

log.info('FileWorker initialized with @parcel/watcher');
