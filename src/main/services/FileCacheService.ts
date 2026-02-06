/**
 * @file FileCacheService - Main-process file content cache
 * @description LRU cache with mtime validation, memory limits, and watcher-driven invalidation
 * @depends fsCompat
 */

import { createHash } from 'crypto';
import path from 'path';
import { createLogger } from './LoggerService';
import fs from './knowledge/utils/fsCompat';

const logger = createLogger('FileCacheService');

// Per-file cache metadata used for validation and eviction decisions.
interface CacheEntry {
  content: string;
  mtime: number;
  size: number;
  hash: string;
  accessCount: number;
  cachedAt: number;
}

// Stats snapshot for monitoring cache efficiency.
export interface FileCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  memoryUsage: number;
  entryCount: number;
  maxMemory: number;
}

// Tunable limits that protect main-process memory usage.
export interface FileCacheConfig {
  maxMemoryMB: number;
  maxEntries: number;
  maxFileSizeMB: number;
  ttlMs: number;
}

export class FileCacheService {
  private cache: Map<string, CacheEntry> = new Map();

  private accessOrder: string[] = [];

  private currentMemoryUsage = 0;

  private stats = { hits: 0, misses: 0 };

  private config: FileCacheConfig = {
    maxMemoryMB: 100,
    maxEntries: 500,
    maxFileSizeMB: 5,
    ttlMs: 5 * 60 * 1000,
  };

  constructor(config?: Partial<FileCacheConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Periodic cleanup avoids accumulating stale entries.
    setInterval(() => this.cleanupExpired(), 60 * 1000);
  }

  /**
   * Gets cached file content when still fresh and unchanged.
   * @sideeffect Updates hit/miss counters and LRU access order
   */
  async get(filePath: string): Promise<{ content: string; fromCache: boolean } | null> {
    const normalizedPath = path.normalize(filePath);
    const cached = this.cache.get(normalizedPath);

    if (cached) {
      // Drop expired entries to avoid serving stale content.
      if (Date.now() - cached.cachedAt > this.config.ttlMs) {
        this.delete(normalizedPath);
        this.stats.misses++;
        return null;
      }

      // Re-check mtime to detect external edits.
      const currentMtime = await this.getFileMtime(normalizedPath);
      if (currentMtime !== null && currentMtime === cached.mtime) {
        this.stats.hits++;
        cached.accessCount++;
        this.updateAccessOrder(normalizedPath);
        return { content: cached.content, fromCache: true };
      }

      // File changed: invalidate cache entry.
      this.delete(normalizedPath);
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Caches file content when it fits limits.
   * @sideeffect May evict older entries to free space
   */
  async set(filePath: string, content: string): Promise<boolean> {
    const normalizedPath = path.normalize(filePath);
    const size = Buffer.byteLength(content, 'utf8');

    // Skip large files to protect memory footprint.
    if (size > this.config.maxFileSizeMB * 1024 * 1024) {
      logger.info(
        `[FileCacheService] File too large to cache: ${filePath} (${(size / 1024 / 1024).toFixed(2)}MB)`
      );
      return false;
    }

    // Ensure space before inserting to keep limits stable.
    await this.ensureSpace(size);

    const mtime = await this.getFileMtime(normalizedPath);
    if (mtime === null) {
      return false;
    }

    const hash = this.computeHash(content);

    // Refresh existing entry to maintain LRU ordering and size accounting.
    if (this.cache.has(normalizedPath)) {
      this.delete(normalizedPath);
    }

    this.cache.set(normalizedPath, {
      content,
      mtime,
      size,
      hash,
      accessCount: 1,
      cachedAt: Date.now(),
    });

    this.currentMemoryUsage += size;
    this.accessOrder.push(normalizedPath);

    return true;
  }

  /** @sideeffect Updates memory usage and LRU ordering */
  delete(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    const entry = this.cache.get(normalizedPath);

    if (entry) {
      this.currentMemoryUsage -= entry.size;
      this.cache.delete(normalizedPath);
      this.accessOrder = this.accessOrder.filter((p) => p !== normalizedPath);
      return true;
    }

    return false;
  }

  /** Called by file watcher when external changes are detected. */
  invalidate(filePath: string): void {
    const normalizedPath = path.normalize(filePath);
    if (this.delete(normalizedPath)) {
      logger.info(`[FileCacheService] Invalidated: ${normalizedPath}`);
    }
  }

  /** Bulk invalidation for directory-level changes. */
  invalidateDirectory(dirPath: string): void {
    const normalizedDir = path.normalize(dirPath);
    const toDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (key.startsWith(normalizedDir)) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.delete(key);
    }

    if (toDelete.length > 0) {
      logger.info(
        `[FileCacheService] Invalidated ${toDelete.length} files in directory: ${normalizedDir}`
      );
    }
  }

  /** @sideeffect Resets memory usage and hit/miss stats */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.currentMemoryUsage = 0;
    this.stats = { hits: 0, misses: 0 };
    logger.info('[FileCacheService] Cache cleared');
  }

  getStats(): FileCacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      memoryUsage: this.currentMemoryUsage,
      entryCount: this.cache.size,
      maxMemory: this.config.maxMemoryMB * 1024 * 1024,
    };
  }

  /**
   * Warms up cache for faster first access after project open.
   * @sideeffect Reads up to 50 files from disk and populates cache
   */
  async warmup(filePaths: string[]): Promise<number> {
    let cached = 0;
    const maxWarmup = Math.min(filePaths.length, 50);

    for (let i = 0; i < maxWarmup; i++) {
      const filePath = filePaths[i];
      try {
        const content = await fs.readFile(filePath, 'utf8');
        if (await this.set(filePath, content)) {
          cached++;
        }
      } catch {
        // Ignore read failures to keep warmup best-effort.
      }
    }

    logger.info(`[FileCacheService] Warmed up ${cached} files`);
    return cached;
  }

  has(filePath: string): boolean {
    return this.cache.has(path.normalize(filePath));
  }

  getCachedPaths(): string[] {
    return Array.from(this.cache.keys());
  }

  // ====== Private Methods ======

  private async getFileMtime(filePath: string): Promise<number | null> {
    try {
      const stat = await fs.stat(filePath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  private computeHash(content: string): string {
    return createHash('md5').update(content).digest('hex').slice(0, 8);
  }

  private updateAccessOrder(filePath: string): void {
    const index = this.accessOrder.indexOf(filePath);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(filePath);
  }

  /** @sideeffect Evicts oldest entries when limits exceeded */
  private async ensureSpace(requiredSize: number): Promise<void> {
    const maxMemory = this.config.maxMemoryMB * 1024 * 1024;

    // Enforce entry count limit.
    while (this.cache.size >= this.config.maxEntries && this.accessOrder.length > 0) {
      const oldest = this.accessOrder[0];
      this.delete(oldest);
    }

    // Enforce memory limit.
    while (this.currentMemoryUsage + requiredSize > maxMemory && this.accessOrder.length > 0) {
      const oldest = this.accessOrder[0];
      this.delete(oldest);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > this.config.ttlMs) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.delete(key);
    }

    if (toDelete.length > 0) {
      logger.info(`[FileCacheService] Cleaned up ${toDelete.length} expired entries`);
    }
  }

  evictOldest(count: number): void {
    const toEvict = Math.min(count, this.accessOrder.length);
    for (let i = 0; i < toEvict; i++) {
      if (this.accessOrder.length > 0) {
        const oldest = this.accessOrder[0];
        this.delete(oldest);
      }
    }
  }
}

// ====== Singleton Access ======
let fileCacheInstance: FileCacheService | null = null;

export function getFileCacheService(): FileCacheService {
  if (!fileCacheInstance) {
    fileCacheInstance = new FileCacheService();
  }
  return fileCacheInstance;
}

/** @sideeffect Replaces singleton instance */
export function createFileCacheService(config?: Partial<FileCacheConfig>): FileCacheService {
  fileCacheInstance = new FileCacheService(config);
  return fileCacheInstance;
}
