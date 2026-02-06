/**
 * @file LRUCache.ts - LRU Cache Service
 * @description High-performance LRU cache for AI completion, document content, RAG search, and other scenarios
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

// RAG search result cache configuration
const RAG_SEARCH_CACHE_OPTIONS = {
  max: 100, // Maximum 100 search results
  ttl: 1000 * 60 * 3, // 3 minutes TTL
  updateAgeOnGet: true,
};

/** AI completion cache item */
interface CompletionCacheItem {
  completion: string;
  timestamp: number;
}

/** Citation information */
interface Citation {
  id: string;
  bibKey?: string;
  text: string;
  source: string;
  page?: number;
}

/** RAG search cache item */
interface RAGSearchCacheItem {
  context: string;
  citations: Citation[];
  searchTime: number;
  timestamp: number;
}

// Create cache instances
const completionCache = new LRUCache<string, CompletionCacheItem>(AI_COMPLETION_CACHE_OPTIONS);
const docContentCache = new LRUCache<string, string>(DOC_CONTENT_CACHE_OPTIONS);
const ragSearchCache = new LRUCache<string, RAGSearchCacheItem>(RAG_SEARCH_CACHE_OPTIONS);

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
 * RAG search cache service
 */
export const RAGSearchCacheService = {
  /**
   * Generate cache key
   */
  generateKey(query: string, libraryId?: string): string {
    // Normalize query: lowercase and remove extra spaces
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${libraryId || 'all'}::${normalizedQuery}`;
  },

  /**
   * Get cached search result
   */
  get(query: string, libraryId?: string): RAGSearchCacheItem | null {
    const key = this.generateKey(query, libraryId);
    const cached = ragSearchCache.get(key);
    if (cached) {
      return cached;
    }
    return null;
  },

  /**
   * Set search result cache
   */
  set(query: string, result: Omit<RAGSearchCacheItem, 'timestamp'>, libraryId?: string): void {
    const key = this.generateKey(query, libraryId);
    ragSearchCache.set(key, {
      ...result,
      timestamp: Date.now(),
    });
  },

  /**
   * Clear cache for specified knowledge base
   */
  clearByLibrary(libraryId: string): void {
    // LRU cache doesn't support prefix deletion, need to iterate
    for (const key of ragSearchCache.keys()) {
      if (key.startsWith(`${libraryId}::`)) {
        ragSearchCache.delete(key);
      }
    }
  },

  /**
   * Clear all search cache
   */
  clear(): void {
    ragSearchCache.clear();
  },

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: ragSearchCache.size,
      max: RAG_SEARCH_CACHE_OPTIONS.max,
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
    RAGSearchCacheService.clear();
  },

  /**
   * Get all cache statistics
   */
  getAllStats() {
    return {
      completion: CompletionCacheService.getStats(),
      docContent: DocContentCacheService.getStats(),
      ragSearch: RAGSearchCacheService.getStats(),
    };
  },
};
