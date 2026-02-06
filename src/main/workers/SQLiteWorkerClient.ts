/**
 * @file SQLiteWorkerClient - Async interface for SQLite Worker communication
 * @description Executes time-consuming database operations in separate thread to avoid UI blocking
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { WorkerRestartManager, createWorkerLogger, delay, getWorkerPath } from './workerUtils';

const logger = createWorkerLogger('SQLiteWorkerClient');

// ============ Type Definitions ============

interface WorkerMessage {
  id: string;
  type:
    | 'init'
    | 'initDatabase'
    | 'deleteLibrary'
    | 'deleteDocument'
    | 'deleteChunksByDocument'
    | 'createChunks'
    | 'insertEmbeddings'
    | 'getDocuments'
    | 'getChunks'
    | 'keywordSearch'
    | 'getSearchResults'
    | 'getDiagnostics'
    | 'getAllLibraries'
    | 'rebuildFTSIndex'
    | 'getChunkById'
    | 'getChunksByIds'
    | 'getDocumentById'
    | 'vectorSearchBruteForce'
    | 'insertEmbeddingSingle'
    | 'close';
  payload: any;
}

/** Chunk data input for Worker communication */
export interface ChunkDataInput {
  content: string;
  chunkType: string;
  metadata: Record<string, any>;
  embedding?: Float32Array | number[];
}

/** Created chunk result */
export interface CreatedChunk {
  id: string;
  documentId: string;
  libraryId: string;
  content: string;
  contentHash: string;
  chunkIndex: number;
  chunkType: string;
}

/** Embedding item - optimized for zero-copy transfer */
export interface EmbeddingItem {
  chunkId: string;
  libraryId: string;
  embedding: Float32Array | number[];
  model?: string;
}

/** Internal serialized format for Worker communication */
interface SerializedEmbeddingItem {
  chunkId: string;
  libraryId: string;
  embeddingBuffer: ArrayBuffer;
  dimensions: number;
  model?: string;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface ProgressMessage {
  id: string;
  type: 'progress';
  progress: number;
  message: string;
}

/**
 * @remarks Progress payload emitted during delete operations.
 */
export interface DeleteProgress {
  progress: number;
  message: string;
}

// ============ Read Operation Return Types ============

/** Document data from Worker */
export interface DocumentData {
  id: string;
  libraryId: string;
  filename: string;
  filePath: string | null;
  fileSize: number;
  fileHash: string | null;
  mediaType: string;
  mimeType: string | null;
  bibKey: string | null;
  citationText: string | null;
  processStatus: string;
  processedAt: number | null;
  errorMessage: string | null;
  metadata: Record<string, any> | null;
  createdAt: number;
  updatedAt: number;
}

/** Chunk data from Worker */
export interface ChunkDataResult {
  id: string;
  documentId: string;
  libraryId: string;
  content: string;
  contentHash: string;
  chunkIndex: number;
  chunkType: string;
  startOffset: number | null;
  endOffset: number | null;
  prevChunkId: string | null;
  nextChunkId: string | null;
  parentChunkId: string | null;
  chunkMetadata: Record<string, any>;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** FTS search result */
export interface FTSSearchResult {
  chunkId: string;
  libraryId: string;
  content: string;
  score: number;
}

/** Search result with document info */
export interface SearchResultData {
  chunkId: string;
  documentId: string;
  libraryId: string;
  content: string;
  score: number;
  mediaType: string;
  filename: string;
  bibKey: string | null;
  citationText: string | null;
  chunkMetadata: Record<string, any>;
}

/** Diagnostics data */
export interface DiagnosticsData {
  totalChunks: number;
  totalEmbeddings: number;
  ftsRecords: number;
  embeddingDimensions: number[];
  libraryStats: Array<{ libraryId: string; chunks: number; embeddings: number }>;
}

/** Knowledge library data */
export interface LibraryData {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  chunkCount: number;
  totalSize: number;
  createdAt: number;
  updatedAt: number;
}

// ============ Worker Client ============

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout?: NodeJS.Timeout;
}

/**
 * @remarks Manages a SQLite Worker and multiplexes request/response pairs.
 * @sideeffect Spawns worker threads and registers progress listeners.
 */
export class SQLiteWorkerClient extends EventEmitter {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private isInitialized = false;
  private dbPath = '';
  private restartManager = new WorkerRestartManager('SQLiteWorkerClient');
  private isRestarting = false;

  /** Generate unique request ID */
  private generateRequestId(): string {
    return `sqlite_${Date.now()}_${this.requestIdCounter++}`;
  }

  /** Send message to Worker and await response */
  private sendMessage<T>(type: WorkerMessage['type'], payload: any, timeout = 300000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not started'));
        return;
      }

      const id = this.generateRequestId();
      const pending: PendingRequest = { resolve, reject };

      pending.timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, timeout);

      this.pendingRequests.set(id, pending);

      const message: WorkerMessage = { id, type, payload };
      this.worker.postMessage(message);
    });
  }

  /** Handle Worker response */
  private handleMessage(response: WorkerResponse | ProgressMessage): void {
    if ('type' in response && response.type === 'progress') {
      const progressMsg = response as ProgressMessage;
      this.emit('progress', {
        requestId: progressMsg.id,
        progress: progressMsg.progress,
        message: progressMsg.message,
      });
      return;
    }

    const resp = response as WorkerResponse;
    const pending = this.pendingRequests.get(resp.id);
    if (!pending) {
      logger.warn('Received response for unknown request:', resp.id);
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.pendingRequests.delete(resp.id);

    if (resp.success) {
      pending.resolve(resp.data);
    } else {
      pending.reject(new Error(resp.error || 'Unknown error'));
    }
  }

  /** Initialize Worker */
  async initialize(dbPath: string): Promise<void> {
    if (this.isInitialized && this.dbPath === dbPath) {
      logger.debug('Already initialized, skipping');
      return;
    }

    if (this.worker && this.dbPath !== dbPath) {
      await this.terminate();
    }

    this.dbPath = dbPath;
    const workerPath = getWorkerPath('sqlite');
    logger.debug('Initializing Worker, path:', workerPath);

    this.worker = new Worker(workerPath);

    this.worker.on('message', (response: WorkerResponse | ProgressMessage) => {
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
      logger.debug('Worker exit, code:', code);
      const previousDbPath = this.dbPath;
      this.isInitialized = false;
      this.worker = null;
      if (code !== 0) {
        this.attemptRestart(previousDbPath);
      }
    });

    await this.sendMessage('init', { dbPath });
    this.isInitialized = true;
    this.restartManager.reset();
    logger.debug('✓ Worker initialized');
  }

  /** Attempt automatic Worker restart */
  private async attemptRestart(dbPath: string): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      logger.error('Max restart count reached, giving up');
      this.emit('maxRestartsReached');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      logger.info('Attempting Worker restart...');
      await this.initialize(dbPath);
      logger.info('✓ Worker restarted');
    } catch (error) {
      logger.error('Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Deletes a knowledge base (executed in Worker thread).
   * @param libraryId The knowledge base ID.
   * @param onProgress Progress callback.
   * @returns True if deletion was successful.
   */
  async deleteLibrary(
    libraryId: string,
    onProgress?: (progress: DeleteProgress) => void
  ): Promise<boolean> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const requestId = this.generateRequestId();

    const progressHandler = (event: { requestId: string; progress: number; message: string }) => {
      if (event.requestId === requestId && onProgress) {
        onProgress({ progress: event.progress, message: event.message });
      }
    };

    this.on('progress', progressHandler);

    try {
      const result = await new Promise<{ deleted: boolean }>((resolve, reject) => {
        if (!this.worker) {
          reject(new Error('Worker not started'));
          return;
        }

        this.pendingRequests.set(requestId, { resolve, reject });

        const message: WorkerMessage = {
          id: requestId,
          type: 'deleteLibrary',
          payload: { libraryId },
        };
        this.worker.postMessage(message);

        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error('Delete operation timeout'));
          }
        }, 300000); // 5 minutes
      });

      return result.deleted;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  /**
   * Deletes a document (executed in Worker thread).
   * Also deletes associated chunks, embeddings, and FTS index.
   * @param documentId The document ID.
   * @param onProgress Progress callback.
   * @returns Object indicating if deletion was successful and the file path.
   */
  async deleteDocument(
    documentId: string,
    onProgress?: (progress: number, message: string) => void
  ): Promise<{ deleted: boolean; filePath: string | null }> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const requestId = this.generateRequestId();

    const progressHandler = (event: { requestId: string; progress: number; message: string }) => {
      if (event.requestId === requestId && onProgress) {
        onProgress(event.progress, event.message);
      }
    };

    this.on('progress', progressHandler);

    try {
      const result = await new Promise<{ deleted: boolean; filePath: string | null }>(
        (resolve, reject) => {
          if (!this.worker) {
            reject(new Error('Worker not started'));
            return;
          }

          this.pendingRequests.set(requestId, { resolve, reject });

          const message: WorkerMessage = {
            id: requestId,
            type: 'deleteDocument',
            payload: { documentId },
          };
          this.worker.postMessage(message);

          setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
              this.pendingRequests.delete(requestId);
              reject(new Error('Delete document timeout'));
            }
          }, 120000); // 2 minutes
        }
      );

      return result;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  /**
   * Deletes all chunks of a document (executed in Worker thread).
   * @param documentId The document ID.
   * @returns The number of chunks deleted.
   */
  async deleteChunksByDocument(documentId: string): Promise<number> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ count: number }>(
      'deleteChunksByDocument',
      { documentId },
      120000
    );

    return result.count;
  }

  /**
   * Creates chunks (executed in Worker thread).
   * @param documentId The document ID.
   * @param libraryId The knowledge base ID.
   * @param chunks Array of chunk data.
   * @param onProgress Progress callback.
   * @returns Array of created chunk information.
   */
  async createChunks(
    documentId: string,
    libraryId: string,
    chunks: ChunkDataInput[],
    onProgress?: (progress: number, message: string) => void
  ): Promise<CreatedChunk[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const requestId = this.generateRequestId();

    const progressHandler = (event: { requestId: string; progress: number; message: string }) => {
      if (event.requestId === requestId && onProgress) {
        onProgress(event.progress, event.message);
      }
    };

    this.on('progress', progressHandler);

    try {
      const result = await new Promise<{ chunks: CreatedChunk[] }>((resolve, reject) => {
        if (!this.worker) {
          reject(new Error('Worker not started'));
          return;
        }

        this.pendingRequests.set(requestId, { resolve, reject });

        const message: WorkerMessage = {
          id: requestId,
          type: 'createChunks',
          payload: { documentId, libraryId, chunks },
        };
        this.worker.postMessage(message);

        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error('Create chunks timeout'));
          }
        }, 300000); // 5 minutes
      });

      return result.chunks;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  /**
   * Batch inserts embedding vectors (executed in Worker thread).
   * Optimizes performance with zero-copy transfer.
   * @param items Array of embedding data.
   * @param onProgress Progress callback.
   * @returns The number of embeddings inserted.
   */
  async insertEmbeddings(
    items: EmbeddingItem[],
    onProgress?: (progress: number, message: string) => void
  ): Promise<number> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const requestId = this.generateRequestId();

    const progressHandler = (event: { requestId: string; progress: number; message: string }) => {
      if (event.requestId === requestId && onProgress) {
        onProgress(event.progress, event.message);
      }
    };

    this.on('progress', progressHandler);

    try {
      const result = await new Promise<{ count: number }>((resolve, reject) => {
        if (!this.worker) {
          reject(new Error('Worker not started'));
          return;
        }

        this.pendingRequests.set(requestId, { resolve, reject });

        // Convert embedding to ArrayBuffer for zero-copy transfer
        const serializedItems: SerializedEmbeddingItem[] = [];
        const transferList: ArrayBuffer[] = [];

        for (const item of items) {
          const float32 =
            item.embedding instanceof Float32Array
              ? item.embedding
              : new Float32Array(item.embedding);

          // Create independent ArrayBuffer copy for transfer
          // slice returns ArrayBuffer | SharedArrayBuffer, needs assertion as ArrayBuffer
          const buffer = float32.buffer.slice(
            float32.byteOffset,
            float32.byteOffset + float32.byteLength
          ) as ArrayBuffer;

          serializedItems.push({
            chunkId: item.chunkId,
            libraryId: item.libraryId,
            embeddingBuffer: buffer,
            dimensions: float32.length,
            model: item.model,
          });

          transferList.push(buffer);
        }

        const message: WorkerMessage = {
          id: requestId,
          type: 'insertEmbeddings',
          payload: { items: serializedItems },
        };

        // Use transferList for zero-copy transfer
        this.worker.postMessage(message, transferList);

        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error('Insert embeddings timeout'));
          }
        }, 300000); // 5 minutes
      });

      return result.count;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  // ============ Read Operation Methods ============

  /**
   * Gets all documents in a knowledge base (executed in Worker thread).
   * @param libraryId The knowledge base ID.
   * @returns List of documents.
   */
  async getDocuments(libraryId: string): Promise<DocumentData[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ documents: DocumentData[] }>(
      'getDocuments' as any,
      { libraryId },
      60000 // 1 minute
    );

    return result.documents;
  }

  /**
   * Gets all chunks of a document (executed in Worker thread).
   * @param documentId The document ID.
   * @returns List of chunks.
   */
  async getChunks(documentId: string): Promise<ChunkDataResult[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ chunks: ChunkDataResult[] }>(
      'getChunks' as any,
      { documentId },
      60000 // 1 minute
    );

    return result.chunks;
  }

  /**
   * FTS5 keyword search (executed in Worker thread).
   * @param query The search query.
   * @param libraryIds Optional list of knowledge base IDs.
   * @param topK Number of results to return.
   * @returns List of search results.
   */
  async keywordSearch(query: string, libraryIds?: string[], topK = 20): Promise<FTSSearchResult[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ results: FTSSearchResult[] }>(
      'keywordSearch' as any,
      { query, libraryIds, topK },
      60000 // 1 minute
    );

    return result.results;
  }

  /**
   * Gets search result details (executed in Worker thread).
   * Includes chunk content and associated document information.
   * @param chunkIds List of chunk IDs.
   * @returns List of search results.
   */
  async getSearchResults(chunkIds: string[]): Promise<SearchResultData[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    if (chunkIds.length === 0) {
      return [];
    }

    const result = await this.sendMessage<{ results: SearchResultData[] }>(
      'getSearchResults',
      { chunkIds },
      60000 // 1 minute
    );

    return result.results;
  }

  /**
   * Gets diagnostic information (executed in Worker thread).
   * @param libraryId Optional knowledge base ID.
   * @returns Diagnostic information.
   */
  async getDiagnostics(libraryId?: string): Promise<DiagnosticsData> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ diagnostics: DiagnosticsData }>(
      'getDiagnostics',
      { libraryId },
      60000
    );

    return result.diagnostics;
  }

  /**
   * Gets all knowledge bases (executed in Worker thread).
   * @returns List of knowledge bases.
   */
  async getAllLibraries(): Promise<LibraryData[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ libraries: LibraryData[] }>(
      'getAllLibraries',
      {},
      60000
    );

    return result.libraries;
  }

  /**
   * Checks if the client is initialized.
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Initializes database schema.
   * Creates all required tables (libraries, documents, chunks, embeddings, chunks_fts).
   */
  async initDatabase(): Promise<{ ftsTableCreated: boolean }> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    return this.sendMessage<{ ftsTableCreated: boolean }>('initDatabase', {}, 60000);
  }

  /**
   * Rebuilds the FTS index.
   * @param onProgress Progress callback.
   * @returns The number of records indexed.
   */
  async rebuildFTSIndex(onProgress?: (progress: number, message: string) => void): Promise<number> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const requestId = this.generateRequestId();

    const progressHandler = (event: { requestId: string; progress: number; message: string }) => {
      if (event.requestId === requestId && onProgress) {
        onProgress(event.progress, event.message);
      }
    };

    this.on('progress', progressHandler);

    try {
      const result = await new Promise<{ count: number }>((resolve, reject) => {
        if (!this.worker) {
          reject(new Error('Worker not started'));
          return;
        }

        this.pendingRequests.set(requestId, { resolve, reject });

        const message: WorkerMessage = {
          id: requestId,
          type: 'rebuildFTSIndex',
          payload: {},
        };
        this.worker.postMessage(message);

        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error('Rebuild FTS index timeout'));
          }
        }, 300000); // 5 minutes
      });

      return result.count;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  /**
   * Gets a single chunk.
   * @param chunkId The chunk ID.
   * @returns Chunk data or null.
   */
  async getChunkById(chunkId: string): Promise<ChunkDataResult | null> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ chunk: ChunkDataResult | null }>(
      'getChunkById' as any,
      { chunkId },
      30000
    );

    return result.chunk;
  }

  /**
   * Gets multiple chunks by IDs.
   * @param chunkIds List of chunk IDs.
   * @returns List of chunk data.
   */
  async getChunksByIds(chunkIds: string[]): Promise<ChunkDataResult[]> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    if (chunkIds.length === 0) {
      return [];
    }

    const result = await this.sendMessage<{ chunks: ChunkDataResult[] }>(
      'getChunksByIds' as any,
      { chunkIds },
      60000
    );

    return result.chunks;
  }

  /**
   * Gets a single document.
   * @param documentId The document ID.
   * @returns Document data or null.
   */
  async getDocumentById(documentId: string): Promise<DocumentData | null> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ document: DocumentData | null }>(
      'getDocumentById' as any,
      { documentId },
      30000
    );

    return result.document;
  }

  /**
   * Vector brute-force search (executed in Worker thread, does not block main process).
   * @param options Search options.
   * @returns Search results.
   */
  async vectorSearchBruteForce(options: {
    embedding: number[];
    libraryIds?: string[];
    topK?: number;
    threshold?: number;
    excludeChunkIds?: string[];
  }): Promise<Array<{ chunkId: string; score: number }>> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    const result = await this.sendMessage<{ results: Array<{ chunkId: string; score: number }> }>(
      'vectorSearchBruteForce' as any,
      options,
      120000 // 2 minutes
    );

    return result.results;
  }

  /**
   * Inserts a single embedding vector.
   * @param chunkId The chunk ID.
   * @param libraryId The knowledge base ID.
   * @param embedding The embedding vector.
   * @param model Model name.
   */
  async insertEmbeddingSingle(
    chunkId: string,
    libraryId: string,
    embedding: number[],
    model?: string
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('SQLiteWorkerClient not initialized');
    }

    await this.sendMessage(
      'insertEmbeddingSingle' as any,
      { chunkId, libraryId, embedding, model },
      30000
    );
  }

  /**
   * Terminates the Worker.
   * Sends a close message first for Worker to perform WAL checkpoint, then terminates.
   */
  async terminate(): Promise<void> {
    this.restartManager.dispose();

    if (this.worker) {
      logger.debug('Terminating Worker...');

      try {
        await this.sendMessage('close', {}, 10000); // 10s timeout, WAL checkpoint may take time
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

let clientInstance: SQLiteWorkerClient | null = null;

/** Get SQLiteWorkerClient singleton */
export function getSQLiteWorkerClient(): SQLiteWorkerClient {
  if (!clientInstance) {
    clientInstance = new SQLiteWorkerClient();
  }
  return clientInstance;
}
