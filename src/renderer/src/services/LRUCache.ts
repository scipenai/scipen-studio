/**
 * @file LRUCache.ts - LRU Cache Service
 * @description High-performance LRU cache for AI completion, document content, and related scenarios
 * @depends lru-cache
 */

import { LRUCache } from 'lru-cache';

// AI completion cache configuration
const AI_COMPLETION_CACHE_OPTIONS = {
  max: 200, // Maximum 200 completion results
  ttl: 1000 * 60 * 5, // 5 minutes TTL
  updateAgeOnGet: true,
  updateAgeOnHas: true,
};

// Document content cache configuration
const DOC_CONTENT_CACHE_OPTIONS = {
  max: 50, // Maximum 50 documents
  ttl: 1000 * 60 * 10, // 10 minutes TTL
  updateAgeOnGet: true,
};

/** AI completion cache item */
interface CompletionCacheItem {
  completion: string;
  timestamp: number;
}

// Create cache instances
const completionCache = new LRUCache<string, CompletionCacheItem>(AI_COMPLETION_CACHE_OPTIONS);
const docContentCache = new LRUCache<string, string>(DOC_CONTENT_CACHE_OPTIONS);

/**
 * AI completion cache service
 */
export const CompletionCacheService = {
  /**
   * Generate cache key based on prefix text and context
   */
  generateKey(prefix: string, context?: string): string {
    // Use only last 200 characters to avoid excessively long keys
    const trimmedPrefix = prefix.slice(-200);
    const trimmedContext = context?.slice(-100) || '';
    return `${trimmedPrefix}::${trimmedContext}`;
  },

  /**
   * Get cached completion result
   */
  get(prefix: string, context?: string): string | null {
    const key = this.generateKey(prefix, context);
    const cached = completionCache.get(key);
    if (cached) {
      return cached.completion;
    }
    return null;
  },

  /**
   * Set completion cache
   */
  set(prefix: string, completion: string, context?: string): void {
    const key = this.generateKey(prefix, context);
    completionCache.set(key, {
      completion,
      timestamp: Date.now(),
    });
  },

  /**
   * Clear all completion cache
   */
  clear(): void {
    completionCache.clear();
  },

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: completionCache.size,
      max: AI_COMPLETION_CACHE_OPTIONS.max,
    };
  },
};

/**
 * Document content cache service
 */
export const DocContentCacheService = {
  /**
   * Get cached document content
   */
  get(docId: string): string | null {
    return docContentCache.get(docId) || null;
  },

  /**
   * Set document content cache
   */
  set(docId: string, content: string): void {
    docContentCache.set(docId, content);
  },

  /**
   * Delete specified document cache
   */
  delete(docId: string): void {
    docContentCache.delete(docId);
  },

  /**
   * Clear all document cache
   */
  clear(): void {
    docContentCache.clear();
  },

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: docContentCache.size,
      max: DOC_CONTENT_CACHE_OPTIONS.max,
    };
  },
};

/**
 * Global cache manager
 */
export const CacheManager = {
  /**
   * Clear all caches
   */
  clearAll(): void {
    CompletionCacheService.clear();
    DocContentCacheService.clear();
  },

  /**
   * Get all cache statistics
   */
  getAllStats() {
    return {
      completion: CompletionCacheService.getStats(),
      docContent: DocContentCacheService.getStats(),
    };
  },
};
