/**
 * @file FileCache.ts - File Content Cache Service
 * @description Renderer process L1 cache layer that reduces IPC calls through LRU strategy
 * @depends IPC, LRU Cache
 */

import type { IDisposable } from '../../../../shared/utils';
import { api } from '../api';

interface L1CacheEntry {
  content: string;
  mtime: number;
  size: number;
  cachedAt: number;
}

export interface L1CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  memoryUsage: number;
  entryCount: number;
}

const MAX_MEMORY_MB = 50;
const MAX_ENTRIES = 200;
const MAX_FILE_SIZE_MB = 1;
const TTL_MS = 2 * 60 * 1000; // 2 minutes

class FileCache implements IDisposable {
  private cache: Map<string, L1CacheEntry> = new Map();
  private accessOrder: string[] = [];
  private currentMemoryUsage = 0;
  private stats = { hits: 0, misses: 0 };
  private initialized = false;

  private _cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private _unsubscribeFileWatcher: (() => void) | null = null;

  private static instance: FileCache;

  private constructor() {}

  static getInstance(): FileCache {
    if (!FileCache.instance) {
      FileCache.instance = new FileCache();
    }
    return FileCache.instance;
  }

  /**
   * Initialize cache service and set up invalidation listeners
   */
  initialize(): void {
    if (this.initialized) return;

    this.setupInvalidationListeners();
    this.initialized = true;

    this._cleanupIntervalId = setInterval(() => this.cleanupExpired(), 30 * 1000);

    console.log('[FileCache L1] Initialized');
  }

  /**
   * Dispose cache service and release all resources
   * Follows VS Code's IDisposable pattern
   */
  dispose(): void {
    if (this._cleanupIntervalId) {
      clearInterval(this._cleanupIntervalId);
      this._cleanupIntervalId = null;
    }

    if (this._unsubscribeFileWatcher) {
      this._unsubscribeFileWatcher();
      this._unsubscribeFileWatcher = null;
    }

    this.clear();
    this.initialized = false;

    console.log('[FileCache L1] Disposed');
  }

  /**
   * Read file with caching
   */
  async readFile(filePath: string): Promise<string> {
    const cached = this.cache.get(filePath);
    if (cached && !this.isExpired(cached)) {
      this.stats.hits++;
      this.updateAccessOrder(filePath);
      return cached.content;
    }

    this.stats.misses++;

    const result = await api.file.read(filePath);

    this.set(filePath, result.content);

    return result.content;
  }

  /**
   * Write file and update cache
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    await api.file.write(filePath, content);

    this.set(filePath, content);
  }

  /**
   * Set cache entry
   */
  private set(filePath: string, content: string): void {
    const size = content.length * 2; // UTF-16 encoding uses 2 bytes per character

    if (size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return;
    }

    this.ensureSpace(size);

    if (this.cache.has(filePath)) {
      this.delete(filePath);
    }

    this.cache.set(filePath, {
      content,
      mtime: Date.now(),
      size,
      cachedAt: Date.now(),
    });

    this.currentMemoryUsage += size;
    this.accessOrder.push(filePath);
  }

  /**
   * Delete cache entry
   */
  private delete(filePath: string): boolean {
    const entry = this.cache.get(filePath);
    if (!entry) return false;

    this.currentMemoryUsage -= entry.size;
    this.cache.delete(filePath);
    this.accessOrder = this.accessOrder.filter((p) => p !== filePath);
    return true;
  }

  /**
   * Manually invalidate cache (called when editor saves)
   */
  invalidate(filePath: string): void {
    this.delete(filePath);
  }

  /**
   * Invalidate all entries in a directory
   */
  invalidateDirectory(dirPath: string): void {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(dirPath)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.delete(key);
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.currentMemoryUsage = 0;
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * Get cache statistics
   */
  getStats(): L1CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      memoryUsage: this.currentMemoryUsage,
      entryCount: this.cache.size,
    };
  }

  /**
   * Check if file is in cache
   */
  has(filePath: string): boolean {
    const entry = this.cache.get(filePath);
    return entry !== undefined && !this.isExpired(entry);
  }

  // ============ Private Methods ============

  /**
   * Check if entry is expired
   */
  private isExpired(entry: L1CacheEntry): boolean {
    return Date.now() - entry.cachedAt > TTL_MS;
  }

  /**
   * Update access order (LRU)
   */
  private updateAccessOrder(filePath: string): void {
    const index = this.accessOrder.indexOf(filePath);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(filePath);
  }

  /**
   * Ensure sufficient space is available
   */
  private ensureSpace(requiredSize: number): void {
    const maxMemory = MAX_MEMORY_MB * 1024 * 1024;

    while (this.cache.size >= MAX_ENTRIES && this.accessOrder.length > 0) {
      const oldest = this.accessOrder[0];
      this.delete(oldest);
    }

    while (this.currentMemoryUsage + requiredSize > maxMemory && this.accessOrder.length > 0) {
      const oldest = this.accessOrder[0];
      this.delete(oldest);
    }
  }

  /**
   * Clean up expired entries
   */
  private cleanupExpired(): void {
    const toDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.delete(key);
    }
  }

  /**
   * Set up invalidation listeners
   * Store cleanup function for disposal
   */
  private setupInvalidationListeners(): void {
    this._unsubscribeFileWatcher = api.fileWatcher.onFileChanged((event) => {
      if (event.type === 'change' || event.type === 'unlink') {
        this.delete(event.path);
      }
    });
  }
}

export const fileCache = FileCache.getInstance();

export type { L1CacheEntry };
