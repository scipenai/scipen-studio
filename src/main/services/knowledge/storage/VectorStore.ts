/**
 * @file VectorStore - Vector Storage Service
 * @description SQLite Worker + HNSW for local vector retrieval with hybrid search (vector + FTS5 full-text)
 * @depends SQLiteWorkerClient, VectorSearchClient, fsCompat
 */

import * as path from 'path';
import { createLogger } from '../../LoggerService';
import type { Chunk, ChunkType, MediaType, SearchResult } from '../types';
import fs from '../utils/fsCompat';

const logger = createLogger('VectorStore');
import {
  type ChunkDataResult,
  type DiagnosticsData,
  type DocumentData,
  type EmbeddingItem,
  type SQLiteWorkerClient,
  getSQLiteWorkerClient,
} from '../../../workers/SQLiteWorkerClient';
import {
  type HNSWConfig,
  type VectorSearchClient,
  type WorkerStats,
  getVectorSearchClient,
} from '../../../workers/VectorSearchClient';

/** Vector search options */
export interface VectorSearchOptions {
  embedding: number[];
  libraryIds?: string[];
  topK?: number;
  threshold?: number;
  excludeChunkIds?: string[];
}

/** Vector store configuration */
export interface VectorStoreConfig {
  dbPath: string;
  dimensions: number;
  useHNSW?: boolean;
  hnswM?: number; // HNSW M parameter
  hnswEfConstruction?: number;
  maxElements?: number; // HNSW maximum elements
  useWorker?: boolean; // Whether to use Worker mode
}

export class VectorStore {
  private config: VectorStoreConfig;
  private workerClient: VectorSearchClient | null = null;
  private workerInitialized = false;
  private workerInitPromise: Promise<void> | null = null;

  // SQLite Worker used for all database operations (no longer uses direct better-sqlite3)
  private sqliteWorkerClient: SQLiteWorkerClient | null = null;
  private sqliteWorkerInitialized = false;
  private sqliteWorkerInitPromise: Promise<void> | null = null;

  constructor(config: VectorStoreConfig) {
    this.config = config;
    fs.ensureDirSync(path.dirname(config.dbPath));

    // Async initialize SQLite Worker and database table structure
    this.initializeSQLiteWorkerAsync();

    // If HNSW enabled, async initialize vector search Worker
    if (config.useHNSW !== false) {
      this.initializeWorkerAsync();
    }
  }

  /**
   * Async initialize SQLite Worker and create database table structure
   */
  private async initializeSQLiteWorkerAsync(): Promise<void> {
    if (this.sqliteWorkerInitPromise) {
      return this.sqliteWorkerInitPromise;
    }

    this.sqliteWorkerInitPromise = (async () => {
      try {
        logger.info('[VectorStore] Initializing SQLite Worker...');
        this.sqliteWorkerClient = getSQLiteWorkerClient();
        await this.sqliteWorkerClient.initialize(this.config.dbPath);
        this.sqliteWorkerInitialized = true;
        logger.info('[VectorStore] ✓ SQLite Worker initialized');

        // Initialize database table structure
        logger.info('[VectorStore] Initializing database table structure...');
        const result = await this.sqliteWorkerClient.initDatabase();
        logger.info('[VectorStore] ✓ Database table structure initialized');

        // If FTS table just created, async check if sync needed
        if (result.ftsTableCreated) {
          logger.info('[VectorStore] FTS table just created, checking if sync needed...');
          this.syncFTSIndexIfNeededAsync();
        }
      } catch (error) {
        console.error('[VectorStore] ✗ SQLite Worker initialization failed:', error);
        this.sqliteWorkerClient = null;
        this.sqliteWorkerInitialized = false;
      }
    })();

    return this.sqliteWorkerInitPromise;
  }

  /**
   * Async check and sync FTS index
   */
  private async syncFTSIndexIfNeededAsync(): Promise<void> {
    if (!this.sqliteWorkerClient || !this.sqliteWorkerInitialized) {
      return;
    }

    try {
      // Get diagnostics to check data state
      const diagnostics = await this.sqliteWorkerClient.getDiagnostics();

      // If chunks exist but FTS records are empty, need to rebuild
      if (diagnostics.totalChunks > 0 && diagnostics.ftsRecords === 0) {
        logger.info(
          '[VectorStore] FTS index out of sync with chunks table, rebuilding in background...'
        );
        const count = await this.sqliteWorkerClient.rebuildFTSIndex((progress, message) => {
          logger.info(`[VectorStore] FTS rebuild progress: ${progress}% - ${message}`);
        });
        logger.info(`[VectorStore] ✓ FTS index rebuild complete: ${count} records`);
      }
    } catch (error) {
      console.error('[VectorStore] FTS sync check failed:', error);
    }
  }

  /**
   * Ensure SQLite Worker is initialized
   */
  async ensureSQLiteWorkerInitialized(): Promise<boolean> {
    if (this.sqliteWorkerInitialized) return true;
    if (this.sqliteWorkerInitPromise) {
      await this.sqliteWorkerInitPromise;
      return this.sqliteWorkerInitialized;
    }
    return false;
  }

  /**
   * Async initialize Worker
   */
  private async initializeWorkerAsync(): Promise<void> {
    if (this.workerInitPromise) {
      return this.workerInitPromise;
    }

    this.workerInitPromise = (async () => {
      try {
        logger.info('[VectorStore] Initializing HNSW Worker...');
        this.workerClient = getVectorSearchClient();

        const hnswConfig: HNSWConfig = {
          dimensions: this.config.dimensions,
          maxElements: this.config.maxElements || 100000,
          m: this.config.hnswM || 16,
          efConstruction: this.config.hnswEfConstruction || 200,
          efSearch: 50,
        };

        await this.workerClient.initialize(this.config.dbPath, hnswConfig);
        this.workerInitialized = true;
        logger.info('[VectorStore] ✓ HNSW Worker initialized');
      } catch (error) {
        console.error('[VectorStore] ✗ HNSW Worker initialization failed:', error);
        this.workerClient = null;
        this.workerInitialized = false;
      }
    })();

    return this.workerInitPromise;
  }

  /**
   * Ensure Worker is initialized
   */
  async ensureWorkerInitialized(): Promise<boolean> {
    if (this.workerInitialized) return true;
    if (this.workerInitPromise) {
      await this.workerInitPromise;
    }
    return this.workerInitialized;
  }

  /**
   * Check if Worker is available
   */
  isWorkerAvailable(): boolean {
    return this.workerInitialized && this.workerClient !== null;
  }

  /**
   * Get Worker statistics
   */
  async getWorkerStats(): Promise<WorkerStats | null> {
    if (!this.workerClient) return null;
    try {
      return await this.workerClient.getStats();
    } catch {
      return null;
    }
  }

  /**
   * Async rebuild FTS index (executed via Worker)
   */
  async rebuildFTSIndexAsync(): Promise<{ success: boolean; count: number }> {
    logger.info('[VectorStore] Starting async FTS index rebuild...');

    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      console.error('[VectorStore] SQLite Worker unavailable');
      return { success: false, count: 0 };
    }

    try {
      const count = await this.sqliteWorkerClient.rebuildFTSIndex((progress, message) => {
        logger.info(`[VectorStore] FTS index progress: ${progress}% - ${message}`);
      });
      logger.info(`[VectorStore] ✓ FTS index async rebuild complete, inserted ${count} records`);
      return { success: true, count };
    } catch (error) {
      console.error('[VectorStore] ✗ FTS index rebuild failed:', error);
      return { success: false, count: 0 };
    }
  }

  /**
   * Insert vector embedding (async, executed via Worker)
   * Note: This method now returns Promise, caller needs await or use .catch() for error handling
   */
  async insertEmbedding(
    chunkId: string,
    libraryId: string,
    embedding: number[],
    model?: string
  ): Promise<void> {
    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      throw new Error('SQLite Worker unavailable');
    }

    await this.sqliteWorkerClient.insertEmbeddingSingle(chunkId, libraryId, embedding, model);

    // Async update HNSW index
    if (this.workerClient && this.workerInitialized) {
      this.workerClient.insertEmbedding(chunkId, libraryId, embedding, model).catch((err) => {
        console.error('[VectorStore] ⚠ HNSW index update failed:', err);
      });
    }
  }

  /**
   * Batch insert vector embeddings (async)
   * Uses SQLite Worker for database operations to avoid blocking main thread
   * Also updates HNSW index
   *
   * Improvement: HNSW update failure doesn't cause overall operation to fail
   * SQLite is the data source, HNSW is acceleration index, can be rebuilt asynchronously
   */
  async insertEmbeddingsBatchAsync(
    items: Array<{ chunkId: string; libraryId: string; embedding: number[]; model?: string }>,
    onProgress?: (progress: number, message: string) => void
  ): Promise<void> {
    logger.info(`[VectorStore] Async batch inserting embeddings: ${items.length} items`);
    if (items.length > 0) {
      logger.info('[VectorStore] Vector dimensions:', items[0].embedding.length);
      logger.info('[VectorStore] Model:', items[0].model);
    }

    const workerReady = await this.ensureSQLiteWorkerInitialized();

    if (!workerReady || !this.sqliteWorkerClient) {
      throw new Error('SQLite Worker unavailable');
    }

    logger.info('[VectorStore] Using SQLite Worker to insert embeddings');

    const embeddingItems: EmbeddingItem[] = items.map((item) => ({
      chunkId: item.chunkId,
      libraryId: item.libraryId,
      embedding: item.embedding,
      model: item.model,
    }));

    // Step 1: Write to SQLite (must succeed) - SQLite is the source of truth
    try {
      await this.sqliteWorkerClient.insertEmbeddings(embeddingItems, (progress, message) => {
        // Database insertion accounts for 50% of total progress
        onProgress?.(Math.round(progress * 0.5), message);
      });
      logger.info('[VectorStore] ✓ SQLite Worker embedding insertion complete');
    } catch (sqliteError) {
      console.error('[VectorStore] ✗ SQLite embedding insertion failed:', sqliteError);
      throw sqliteError; // Re-throw: data must be written successfully
    }

    // Step 2: Update HNSW index (failures are allowed, isolated with try-catch)
    // HNSW is an acceleration index; failures fall back to brute-force search
    if ((await this.ensureWorkerInitialized()) && this.workerClient) {
      onProgress?.(60, 'Updating HNSW index...');
      try {
        await this.workerClient.insertEmbeddingsBatch(items);
        logger.info('[VectorStore] ✓ HNSW index update complete');
        onProgress?.(100, 'HNSW index update complete');
      } catch (hnswError) {
        // HNSW update failure is not fatal - search will automatically fall back to brute-force via SQLite Worker
        console.warn(
          '[VectorStore] ⚠ HNSW index update failed, will fall back to brute-force search:',
          hnswError
        );
        onProgress?.(100, 'Complete (HNSW index update failed, will use brute-force search)');
        // Don't throw error since SQLite data was written successfully
      }
    } else {
      onProgress?.(100, 'Complete (no HNSW index)');
    }
  }

  /**
   * Asynchronous vector search (uses HNSW index)
   * Recommended method - does not block main process
   */
  async searchByVectorAsync(
    options: VectorSearchOptions
  ): Promise<Array<{ chunkId: string; score: number }>> {
    const { embedding, libraryIds, topK = 10, threshold = 0.3, excludeChunkIds = [] } = options;

    logger.info('[VectorStore] ========== Async vector search started ==========');
    logger.info('[VectorStore] Query vector dimensions:', embedding.length);
    logger.info('[VectorStore] Library IDs:', libraryIds);
    logger.info(`[VectorStore] topK: ${topK}, threshold: ${threshold}`);

    if ((await this.ensureWorkerInitialized()) && this.workerClient) {
      logger.info('[VectorStore] Using HNSW Worker to execute search');
      try {
        const results = await this.workerClient.search({
          embedding,
          libraryIds,
          topK,
          threshold,
          excludeChunkIds,
        });
        logger.info('[VectorStore] HNSW search result count:', results.length);
        logger.info('[VectorStore] ========== Async vector search ended ==========');
        return results;
      } catch (error) {
        console.error(
          '[VectorStore] HNSW Worker search failed, falling back to brute-force search:',
          error
        );
      }
    }

    logger.info('[VectorStore] Falling back to SQLite Worker brute-force search');
    return this.searchByVectorBruteForceAsync(options);
  }

  /**
   * Brute-force search implementation (executed via SQLite Worker)
   */
  private async searchByVectorBruteForceAsync(
    options: VectorSearchOptions
  ): Promise<Array<{ chunkId: string; score: number }>> {
    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      console.error('[VectorStore] SQLite Worker unavailable');
      return [];
    }

    logger.info('[VectorStore] ========== Brute-force vector search started (Worker) ==========');
    logger.info('[VectorStore] Query vector dimensions:', options.embedding.length);
    logger.info('[VectorStore] Library IDs:', options.libraryIds);
    logger.info(`[VectorStore] topK: ${options.topK}, threshold: ${options.threshold}`);

    try {
      const results = await this.sqliteWorkerClient.vectorSearchBruteForce(options);
      logger.info('[VectorStore] ========== Brute-force vector search ended ==========');
      return results;
    } catch (error) {
      console.error('[VectorStore] Brute-force search failed:', error);
      return [];
    }
  }

  /**
   * Full-text search (uses SQLite Worker thread)
   */
  async searchByKeywordAsync(
    query: string,
    libraryIds?: string[],
    topK = 10,
    excludeChunkIds: string[] = []
  ): Promise<Array<{ chunkId: string; score: number; highlights: string[] }>> {
    logger.info('[VectorStore] ========== Async keyword search started ==========');
    logger.info(`[VectorStore] Query: ${query.slice(0, 100)}...`);
    logger.info('[VectorStore] Library IDs:', libraryIds);

    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      console.error('[VectorStore] SQLite Worker unavailable');
      return [];
    }

    try {
      const workerResults = await this.sqliteWorkerClient.keywordSearch(
        query,
        libraryIds,
        topK * 2 // Fetch more results for filtering
      );

      logger.info(`[VectorStore] Worker FTS search returned: ${workerResults.length} results`);

      const excludeSet = new Set(excludeChunkIds);
      const filteredResults = workerResults
        .filter((r) => !excludeSet.has(r.chunkId))
        .slice(0, topK);

      // ========================================================================
      // BM25 Score Adaptive Normalization (Max-Score Anchoring Strategy)
      // ========================================================================
      //
      // Why normalize?
      // - BM25 raw scores have variable ranges (0-5 or 0-50+), depending on query term frequency
      // - Cosine similarity is fixed in [-1, 1], typically normalized to [0, 1]
      // - Direct fusion causes scale mismatch; BM25 may dominate ranking
      //
      // Why Sigmoid instead of Min-Max?
      // - Min-Max depends on batch min/max, making results incomparable across queries
      // - Sigmoid provides stable S-shaped mapping independent of batch boundaries
      //
      // Why adaptive midpoint?
      // - Fixed midpoint (e.g., 10) performs inconsistently across query scenarios
      // - Short queries (e.g., single word "optimize") have low BM25 scores; fixed midpoint compresses effective score range
      // - Long queries (e.g., technical term combinations) have high BM25 scores; fixed midpoint causes too many results clustered at 0.9+
      // - Using 50% of maxScore as anchor ensures reasonable score distribution for each query
      //
      // Formula: sigmoid(x) = 1 / (1 + exp(-k * (x - midpoint)))
      // where midpoint = maxScore * 0.5, k = 5 / maxScore
      // ========================================================================

      let adaptiveMidpoint = 10; // Default fallback value (used when no results)
      let k = 0.1; // Default steepness

      if (filteredResults.length > 0) {
        const scores = filteredResults.map((r) => r.score);
        const maxScore = Math.max(...scores);

        if (maxScore > 0) {
          // Anchor point: 50% of max score
          // Effect: documents at half max score → normalized score = 0.5
          //         documents near max score → normalized score ≈ 0.9 - 0.95
          adaptiveMidpoint = maxScore * 0.5;

          // Steepness: larger score range → gentler curve
          // Effect: prevents excessive compression in high-score range, preserves score differences
          // Lower bound 0.05 prevents curve from being too flat and losing discriminative power
          k = Math.max(0.05, 5 / maxScore);
        }
      }

      const normalizedResults = filteredResults.map((r) => ({
        chunkId: r.chunkId,
        score: this.normalizeBM25Score(r.score, k, adaptiveMidpoint),
        highlights: [`${r.content.slice(0, 200)}...`],
      }));

      logger.info(
        `[VectorStore] Adaptive BM25: maxScore=${filteredResults[0]?.score?.toFixed(1)}, midpoint=${adaptiveMidpoint.toFixed(1)}, k=${k.toFixed(3)}`
      );

      logger.info('[VectorStore] Async keyword search result count:', normalizedResults.length);
      if (normalizedResults.length > 0) {
        logger.info(
          `[VectorStore] BM25 normalized score range: ${normalizedResults[normalizedResults.length - 1]?.score.toFixed(3)} - ${normalizedResults[0]?.score.toFixed(3)}`
        );
      }
      logger.info('[VectorStore] ========== Async keyword search ended ==========');

      return normalizedResults;
    } catch (error) {
      console.error('[VectorStore] Worker FTS search failed:', error);
      return [];
    }
  }

  /**
   * Hybrid search (vector + keyword)
   * Recommended method - dual-path parallel retrieval:
   * - Vector search uses HNSW Worker
   * - Keyword search uses SQLite Worker
   */
  async hybridSearchAsync(
    queryEmbedding: number[],
    queryText: string,
    options: {
      libraryIds?: string[];
      topK?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      threshold?: number;
      excludeChunkIds?: string[];
    } = {}
  ): Promise<Array<{ chunkId: string; score: number; vectorScore: number; keywordScore: number }>> {
    const {
      libraryIds,
      topK = 10,
      vectorWeight = 0.7,
      keywordWeight = 0.3,
      threshold = 0.3,
      excludeChunkIds = [],
    } = options;

    logger.info('[VectorStore] ========== Parallel hybrid search started ==========');
    const startTime = Date.now();

    // Execute vector and keyword searches in parallel
    const [vectorResults, keywordResults] = await Promise.all([
      // Asynchronous vector retrieval (HNSW Worker)
      this.searchByVectorAsync({
        embedding: queryEmbedding,
        libraryIds,
        topK: topK * 2,
        threshold: 0.1,
        excludeChunkIds,
      }),
      // Asynchronous keyword retrieval (SQLite Worker)
      this.searchByKeywordAsync(queryText, libraryIds, topK * 2, excludeChunkIds),
    ]);

    const parallelTime = Date.now() - startTime;
    logger.info(
      `[VectorStore] Parallel search duration: ${parallelTime}ms (vector:${vectorResults.length} results, keyword:${keywordResults.length} results)`
    );

    // Fuse results
    const fusedResults = this.fuseResults(vectorResults, keywordResults, {
      vectorWeight,
      keywordWeight,
      threshold,
      topK,
    });

    logger.info(
      `[VectorStore] ========== Parallel hybrid search ended (total duration: ${Date.now() - startTime}ms) ==========`
    );
    return fusedResults;
  }

  /**
   * Fuse vector search and keyword search results
   */
  private fuseResults(
    vectorResults: Array<{ chunkId: string; score: number }>,
    keywordResults: Array<{ chunkId: string; score: number; highlights?: string[] }>,
    options: {
      vectorWeight: number;
      keywordWeight: number;
      threshold: number;
      topK: number;
    }
  ): Array<{ chunkId: string; score: number; vectorScore: number; keywordScore: number }> {
    const { vectorWeight, keywordWeight, threshold, topK } = options;

    const resultMap = new Map<
      string,
      {
        vectorScore: number;
        keywordScore: number;
      }
    >();

    // Vector scores are already in 0-1 range (cosine similarity)
    for (const r of vectorResults) {
      resultMap.set(r.chunkId, {
        vectorScore: r.score,
        keywordScore: 0,
      });
    }

    // Keyword scores are normalized to 0-1 range via sigmoid
    // Both score types are now on the same scale and comparable
    for (const r of keywordResults) {
      const existing = resultMap.get(r.chunkId);
      if (existing) {
        existing.keywordScore = r.score;
      } else {
        resultMap.set(r.chunkId, {
          vectorScore: 0,
          keywordScore: r.score,
        });
      }
    }

    // Calculate fused scores
    const hasVectorResults = vectorResults.length > 0;
    const hasKeywordResults = keywordResults.length > 0;

    // Dynamically adjust weights
    let adjustedVectorWeight = vectorWeight;
    let adjustedKeywordWeight = keywordWeight;

    if (!hasVectorResults && hasKeywordResults) {
      adjustedVectorWeight = 0;
      adjustedKeywordWeight = 1.0;
    } else if (hasVectorResults && !hasKeywordResults) {
      adjustedVectorWeight = 1.0;
      adjustedKeywordWeight = 0;
    }

    logger.info(
      `[VectorStore] Fusion weights: vector=${adjustedVectorWeight}, keyword=${adjustedKeywordWeight}`
    );
    logger.info(
      `[VectorStore] Vector result count: ${vectorResults.length}, keyword result count: ${keywordResults.length}`
    );

    // Use lower threshold when only keyword results are available
    const effectiveThreshold =
      !hasVectorResults && hasKeywordResults ? Math.min(threshold, 0.1) : threshold;

    const fusedResults: Array<{
      chunkId: string;
      score: number;
      vectorScore: number;
      keywordScore: number;
    }> = [];

    for (const [chunkId, scores] of resultMap) {
      const fusedScore =
        adjustedVectorWeight * scores.vectorScore + adjustedKeywordWeight * scores.keywordScore;

      if (fusedScore >= effectiveThreshold) {
        fusedResults.push({
          chunkId,
          score: fusedScore,
          vectorScore: scores.vectorScore,
          keywordScore: scores.keywordScore,
        });
      }
    }

    logger.info(
      `[VectorStore] Fused result count: ${fusedResults.length}, threshold: ${effectiveThreshold}`
    );
    if (fusedResults.length > 0) {
      logger.info(
        `[VectorStore] Score range: ${fusedResults[fusedResults.length - 1]?.score.toFixed(3)} - ${fusedResults[0]?.score.toFixed(3)}`
      );
    }

    fusedResults.sort((a, b) => b.score - a.score);
    return fusedResults.slice(0, topK);
  }

  /**
   * BM25 score normalization
   *
   * BM25 returns relevance scores (after absolute value), typically in range 0-50+
   * Uses sigmoid transformation to map to 0-1 range, ensuring cross-batch comparability
   *
   * Parameters:
   * - k: Controls sigmoid curve steepness; smaller values make curve gentler
   * - midpoint: BM25 score at which sigmoid outputs 0.5
   *
   * Typical BM25 score ranges:
   * - 0-5: Weak relevance
   * - 5-15: Moderate relevance
   * - 15-30: Strong relevance
   * - 30+: Very strong relevance
   */
  private normalizeBM25Score(bm25Score: number, k = 0.1, midpoint = 10): number {
    // Sigmoid formula: 1 / (1 + e^(-k * (x - midpoint)))
    // Maps BM25 scores to (0, 1) range
    // With midpoint=10: BM25=10 maps to 0.5
    // BM25=0 maps to ~0.27
    // BM25=30 maps to ~0.88
    return 1 / (1 + Math.exp(-k * (bm25Score - midpoint)));
  }

  /**
   * Get chunk details (asynchronous, executed via Worker)
   */
  async getChunkById(chunkId: string): Promise<Chunk | null> {
    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      throw new Error('SQLite Worker unavailable');
    }

    const result = await this.sqliteWorkerClient.getChunkById(chunkId);
    if (!result) return null;

    return this.mapChunkDataToChunk(result);
  }

  /**
   * Batch get chunk details (async, executed via Worker)
   */
  async getChunksByIds(chunkIds: string[]): Promise<Chunk[]> {
    if (chunkIds.length === 0) return [];

    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      throw new Error('SQLite Worker unavailable');
    }

    const results = await this.sqliteWorkerClient.getChunksByIds(chunkIds);
    return results.map((row) => this.mapChunkDataToChunk(row));
  }

  /**
   * Get document information (async, executed via Worker)
   */
  async getDocumentById(documentId: string): Promise<DocumentData | null> {
    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      throw new Error('SQLite Worker unavailable');
    }

    return this.sqliteWorkerClient.getDocumentById(documentId);
  }

  /**
   * Map ChunkDataResult to Chunk object
   */
  private mapChunkDataToChunk(data: ChunkDataResult): Chunk {
    return {
      id: data.id,
      documentId: data.documentId,
      libraryId: data.libraryId,
      content: data.content,
      contentHash: data.contentHash,
      chunkIndex: data.chunkIndex,
      chunkType: data.chunkType as ChunkType,
      startOffset: data.startOffset ?? undefined,
      endOffset: data.endOffset ?? undefined,
      prevChunkId: data.prevChunkId ?? undefined,
      nextChunkId: data.nextChunkId ?? undefined,
      parentChunkId: data.parentChunkId ?? undefined,
      chunkMetadata: data.chunkMetadata,
      isEnabled: data.isEnabled,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }

  /**
   * Get complete search results (uses SQLite Worker)
   */
  async getSearchResultsAsync(chunkIds: string[]): Promise<SearchResult[]> {
    if (chunkIds.length === 0) return [];

    // Ensure SQLite Worker is initialized
    const workerReady = await this.ensureSQLiteWorkerInitialized();

    if (!workerReady || !this.sqliteWorkerClient) {
      console.error('[VectorStore] SQLite Worker unavailable');
      return [];
    }

    try {
      const results = await this.sqliteWorkerClient.getSearchResults(chunkIds);
      // Convert SearchResultData to SearchResult (add type conversion)
      return results.map((r) => ({
        ...r,
        mediaType: r.mediaType as MediaType,
        bibKey: r.bibKey ?? undefined,
        citationText: r.citationText ?? undefined,
      }));
    } catch (error) {
      console.error('[VectorStore] Failed to get search results:', error);
      return [];
    }
  }

  /**
   * Close database connection and Workers
   */
  async close(): Promise<void> {
    // Close HNSW Worker
    if (this.workerClient) {
      try {
        await this.workerClient.terminate();
      } catch (err) {
        console.error('[VectorStore] HNSW Worker close failed:', err);
      }
      this.workerClient = null;
      this.workerInitialized = false;
    }

    // Close SQLite Worker
    if (this.sqliteWorkerClient) {
      try {
        await this.sqliteWorkerClient.terminate();
      } catch (err) {
        console.error('[VectorStore] SQLite Worker close failed:', err);
      }
      this.sqliteWorkerClient = null;
      this.sqliteWorkerInitialized = false;
    }
  }

  /**
   * Get database path (for modules like DocumentStore that need to share the same database)
   */
  getDbPath(): string {
    return this.config.dbPath;
  }

  /**
   * Get SQLite Worker client (for other modules to use)
   * Note: No longer provides direct database instance, all operations should be executed via Worker
   */
  getSQLiteWorkerClient(): SQLiteWorkerClient | null {
    return this.sqliteWorkerClient;
  }

  /**
   * Get diagnostics (async, executed via Worker)
   */
  async getDiagnostics(libraryId?: string): Promise<DiagnosticsData> {
    logger.info('[VectorStore] ========== Getting diagnostics ==========');

    const workerReady = await this.ensureSQLiteWorkerInitialized();
    if (!workerReady || !this.sqliteWorkerClient) {
      console.error('[VectorStore] SQLite Worker unavailable');
      return {
        totalChunks: 0,
        totalEmbeddings: 0,
        ftsRecords: 0,
        embeddingDimensions: [],
        libraryStats: [],
      };
    }

    const diagnostics = await this.sqliteWorkerClient.getDiagnostics(libraryId);

    logger.info('[VectorStore] Total chunks:', diagnostics.totalChunks);
    logger.info('[VectorStore] Total embeddings:', diagnostics.totalEmbeddings);
    logger.info('[VectorStore] FTS records:', diagnostics.ftsRecords);
    logger.info('[VectorStore] Embedding dimensions:', diagnostics.embeddingDimensions);
    logger.info(`[VectorStore] Library statistics (${diagnostics.libraryStats.length} total):`);
    diagnostics.libraryStats.forEach((stat) => {
      logger.info(`  - ${stat.libraryId}: ${stat.chunks} chunks, ${stat.embeddings} embeddings`);
    });
    logger.info('[VectorStore] ========== Diagnostics ended ==========');

    return diagnostics;
  }
}
