/**
 * @file VectorSearchClient - Vector Search Worker Client
 * @description Provides async interface for vectorSearch.worker communication, executes HNSW vector retrieval
 * @depends worker_threads, workerUtils
 */

import { Worker } from 'worker_threads';
import { WorkerRestartManager, createWorkerLogger, delay, getWorkerPath } from './workerUtils';

const logger = createWorkerLogger('VectorSearchClient');

// ====== Type Definitions ======

interface WorkerMessage {
  id: string;
  type: 'init' | 'search' | 'insert' | 'insertBatch' | 'rebuild' | 'getStats' | 'close';
  payload: any;
  // Marks if this message uses Transferable (for search operation embeddings)
  hasTransferable?: boolean;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface VectorSearchOptions {
  /** Vector embedding - supports number[] or Float32Array */
  embedding: number[] | Float32Array;
  libraryIds?: string[];
  topK?: number;
  threshold?: number;
  excludeChunkIds?: string[];
}

export interface HNSWConfig {
  dimensions: number;
  maxElements: number;
  m?: number;
  efConstruction?: number;
  efSearch?: number;
}

export interface VectorSearchResult {
  chunkId: string;
  score: number;
}

export interface WorkerStats {
  isInitialized: boolean;
  indexSize: number;
  dimensions: number;
  mappingSize: number;
}

// ====== Timeout Configuration ======

/** Operation timeout durations (ms) */
const OPERATION_TIMEOUTS = {
  init: 60000, // 1 minute (index initialization)
  search: 30000, // 30 seconds
  insert: 30000, // 30 seconds
  insertBatch: 120000, // 2 minutes (batch insert)
  rebuild: 300000, // 5 minutes (index rebuild)
  getStats: 10000, // 10 seconds
} as const;

// ====== Worker Client ======

export class VectorSearchClient {
  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private requestIdCounter = 0;
  private isInitialized = false;
  private dbPath = '';
  private hnswConfig: HNSWConfig | undefined;
  private restartManager = new WorkerRestartManager('VectorSearchClient');
  private isRestarting = false;

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${this.requestIdCounter++}`;
  }

  /**
   * Send message to Worker and wait for response
   * @param type Message type
   * @param payload Message payload
   * @param transferList Optional Transferable object list for zero-copy transfer
   * @param customTimeout Custom timeout (ms)
   */
  private sendMessage<T>(
    type: WorkerMessage['type'],
    payload: any,
    transferList?: ArrayBuffer[],
    customTimeout?: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not started'));
        return;
      }

      const id = this.generateRequestId();

      // Use operation-specific timeout or custom timeout
      const timeout =
        customTimeout ?? OPERATION_TIMEOUTS[type as keyof typeof OPERATION_TIMEOUTS] ?? 30000;

      const timeoutHandle = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${type} (${timeout}ms)`));
        }
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });

      const message: WorkerMessage = {
        id,
        type,
        payload,
        hasTransferable: transferList && transferList.length > 0,
      };

      // Use transferList for zero-copy transfer
      if (transferList && transferList.length > 0) {
        this.worker.postMessage(message, transferList);
      } else {
        this.worker.postMessage(message);
      }
    });
  }

  /**
   * Handle Worker response
   */
  private handleMessage(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn('Received response for unknown request:', response.id);
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || 'Unknown error'));
    }
  }

  /**
   * Initialize Worker
   */
  async initialize(dbPath: string, hnswConfig: HNSWConfig): Promise<void> {
    if (this.isInitialized) {
      logger.debug('Already initialized, skipping');
      return;
    }

    // Save config for auto-restart recovery
    this.dbPath = dbPath;
    this.hnswConfig = hnswConfig;

    const workerPath = getWorkerPath('vectorSearch');
    logger.debug('Initializing Worker, path:', workerPath);

    this.worker = new Worker(workerPath);
    this.worker.on('message', (response: WorkerResponse) => {
      this.handleMessage(response);
    });

    this.worker.on('error', (error) => {
      logger.error('Worker error:', error);
      for (const [id, pending] of this.pendingRequests) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        pending.reject(error);
        this.pendingRequests.delete(id);
      }
    });

    this.worker.on('exit', (code) => {
      logger.debug('Worker exited, code:', code);
      this.isInitialized = false;
      this.worker = null;
      // If abnormal exit, attempt auto-restart
      if (code !== 0) {
        this.attemptRestart();
      }
    });

    await this.sendMessage('init', { dbPath, hnswConfig });
    this.isInitialized = true;
    // Worker successfully initialized, reset restart count
    this.restartManager.reset();
    logger.debug('✓ Worker initialization complete');
  }

  /**
   * Attempt to auto-restart Worker
   */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting || !this.dbPath || !this.hnswConfig) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      logger.error('Reached max restart attempts, no longer attempting restart');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      logger.info('Attempting to restart Worker...');
      await this.initialize(this.dbPath, this.hnswConfig);
      logger.info('✓ Worker restart successful');
    } catch (error) {
      logger.error('Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Vector search
   * Uses Transferable for zero-copy transfer, reducing IPC overhead for large vectors
   *
   * @param options Search options
   * @param options.embedding Vector embedding (number[] or Float32Array)
   * @returns Search result array
   */
  async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    if (!this.isInitialized) {
      throw new Error('VectorSearchClient not initialized');
    }

    const { embedding, ...restOptions } = options;

    // Why Float32Array? Required for Transferable zero-copy transfer
    let float32Embedding: Float32Array;
    if (embedding instanceof Float32Array) {
      // Create copy since original buffer will be transferred (becomes unavailable)
      float32Embedding = new Float32Array(embedding);
    } else {
      float32Embedding = new Float32Array(embedding);
    }

    const embeddingBuffer = float32Embedding.buffer;
    const payload = {
      ...restOptions,
      embeddingBuffer, // Transfer ArrayBuffer instead of number[]
      embeddingLength: float32Embedding.length,
    };

    // Use Transferable for zero-copy transfer
    // Note: After transfer, embeddingBuffer will be unavailable in main thread
    return this.sendMessage<VectorSearchResult[]>('search', payload, [
      embeddingBuffer as ArrayBuffer,
    ]);
  }

  /**
   * Insert single vector
   */
  async insertEmbedding(
    chunkId: string,
    libraryId: string,
    embedding: number[],
    model?: string
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('VectorSearchClient not initialized');
    }
    await this.sendMessage('insert', { chunkId, libraryId, embedding, model });
  }

  /**
   * Batch insert vectors
   */
  async insertEmbeddingsBatch(
    items: Array<{ chunkId: string; libraryId: string; embedding: number[]; model?: string }>
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('VectorSearchClient not initialized');
    }
    await this.sendMessage('insertBatch', { items });
  }

  /**
   * Rebuild HNSW index
   */
  async rebuildIndex(config: HNSWConfig): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('VectorSearchClient not initialized');
    }
    await this.sendMessage('rebuild', config);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<WorkerStats> {
    if (!this.isInitialized) {
      return {
        isInitialized: false,
        indexSize: 0,
        dimensions: 0,
        mappingSize: 0,
      };
    }
    return this.sendMessage<WorkerStats>('getStats', {});
  }

  /**
   * Check if initialized
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Terminate Worker
   * Sends close message first to let Worker save index, then terminates
   */
  async terminate(): Promise<void> {
    // Cleanup restart manager
    this.restartManager.dispose();

    if (this.worker) {
      logger.debug('Terminating Worker...');

      // Why send close first? Allows Worker to save index state before termination
      try {
        await this.sendMessage('close', {}, undefined, 10000); // 10 second timeout
        logger.debug('✓ Worker close message sent');
      } catch (err) {
        logger.warn('Failed to send close message, terminating directly:', err);
      }

      for (const pending of this.pendingRequests.values()) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        pending.reject(new Error('Worker is closing'));
      }
      this.pendingRequests.clear();

      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      logger.debug('✓ Worker terminated');
    }
  }
}

// Singleton instance
let clientInstance: VectorSearchClient | null = null;

/**
 * Get VectorSearchClient singleton
 */
export function getVectorSearchClient(): VectorSearchClient {
  if (!clientInstance) {
    clientInstance = new VectorSearchClient();
  }
  return clientInstance;
}
