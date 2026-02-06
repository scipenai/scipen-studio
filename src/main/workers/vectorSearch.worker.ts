/**
 * @file Vector Search Worker
 * @description High-performance vector retrieval using HNSW index in a separate thread.
 * @depends better-sqlite3, hnswlib-node
 *
 * Architecture decisions:
 * - Why Worker thread? Vector search is CPU-intensive; running on main process blocks IPC.
 * - Why HNSW? O(log n) approximate nearest neighbor vs O(n) brute force.
 * - Why persist index? Building HNSW requires scanning all vectors (~30s for 500 docs),
 *   persistence enables cold start in <100ms.
 *
 * Memory considerations:
 * - Each 1024-dim vector ~4KB, 100k vectors ~400MB
 * - HNSW graph overhead ~100 bytes/vector
 * - For large knowledge bases, consider LRU eviction strategy
 */

import Database from 'better-sqlite3';
// CommonJS module compatible import
import hnswlib from 'hnswlib-node';
import { parentPort } from 'worker_threads';
const { HierarchicalNSW } = hnswlib;

// ============ Type Definitions ============

/** All supported operation types */
type VectorSearchOperationType =
  | 'init'
  | 'search'
  | 'insert'
  | 'insertBatch'
  | 'rebuild'
  | 'getStats'
  | 'close';

/** Worker message - simplified type, runtime safe via switch branches */
interface WorkerMessage {
  id: string;
  type: VectorSearchOperationType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any; // Runtime type handled by switch branches
  hasTransferable?: boolean;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  error?: string;
}

interface VectorSearchOptions {
  embedding?: Float32Array | number[]; // Legacy format
  // Zero-copy transfer format (from VectorSearchClient)
  embeddingBuffer?: ArrayBuffer;
  embeddingLength?: number;
  libraryIds?: string[];
  topK?: number;
  threshold?: number;
  excludeChunkIds?: string[];
}

// Serialized format for zero-copy transfer
interface SerializedEmbeddingItem {
  chunkId: string;
  libraryId: string;
  embeddingBuffer: ArrayBuffer; // Zero-copy transfer ArrayBuffer
  dimensions: number;
  model?: string;
}

/**
 * HNSW index configuration.
 *
 * Parameter tuning notes:
 * - M (neighbors): Higher = better recall but more memory/build time. 16 is balanced.
 * - efConstruction: Build-time search range. Higher = better quality but slower. 200 recommended.
 * - efSearch: Search-time search range. Higher = better recall but slower. 50 is balanced.
 *
 * Why Cosine distance?
 * Text embedding models (e.g., text-embedding-3-small) output normalized vectors.
 * Cosine similarity is better suited for semantic similarity than Euclidean distance.
 */
interface HNSWConfig {
  dimensions: number;
  maxElements: number;
  m?: number; // HNSW M parameter (default 16)
  efConstruction?: number; // ef for construction (default 200)
  efSearch?: number; // ef for search (default 50)
}

// ============ Worker State ============

let db: Database.Database | null = null;
let hnswIndex: InstanceType<typeof HierarchicalNSW> | null = null;
let chunkIdToLabel: Map<string, number> = new Map();
let labelToChunkId: Map<number, string> = new Map();
let labelToLibraryId: Map<number, string> = new Map();
let currentLabel = 0;
let dimensions = 0;
let isInitialized = false;

// ============ Utility Functions ============

/**
 * Converts Buffer to Float32Array (zero-copy).
 */
function bufferToFloat32Array(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / Float32Array.BYTES_PER_ELEMENT
  );
}

/**
 * Converts Float32Array or number[] to Buffer.
 */
function float32ArrayToBuffer(arr: Float32Array | number[]): Buffer {
  const float32 = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Ensures input is Float32Array (performance optimization).
 */
function ensureFloat32Array(arr: Float32Array | number[]): Float32Array {
  return arr instanceof Float32Array ? arr : new Float32Array(arr);
}

/**
 * Creates Float32Array from ArrayBuffer (for zero-copy receiving).
 */
function arrayBufferToFloat32(buffer: ArrayBuffer): Float32Array {
  return new Float32Array(buffer);
}

/**
 * Sends response to main process.
 */
function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

/**
 * Logs messages (dev mode only).
 */
const isDev = process.env.NODE_ENV === 'development';
function log(message: string, ...args: any[]): void {
  if (isDev) console.info(`[VectorWorker] ${message}`, ...args);
}

// ============ Core Functions ============

// HNSW index file path (same directory as database)
let hnswIndexPath: string | null = null;
let hnswMappingPath: string | null = null;

/**
 * Initializes the Worker.
 *
 * P2 optimization: supports HNSW index persistence.
 * - If index file exists, load directly (milliseconds)
 * - Otherwise rebuild from database (seconds~minutes)
 */
async function initialize(config: {
  dbPath: string;
  hnswConfig: HNSWConfig;
}): Promise<void> {
  const { dbPath, hnswConfig } = config;

  log('Initializing Worker...');
  log('Database path:', dbPath);
  log('HNSW config:', hnswConfig);

  db = new Database(dbPath, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  dimensions = hnswConfig.dimensions;

  const basePath = dbPath.replace(/\.db$/, '');
  hnswIndexPath = `${basePath}.hnsw.index`;
  hnswMappingPath = `${basePath}.hnsw.mapping.json`;

  const m = hnswConfig.m || 16;
  const efConstruction = hnswConfig.efConstruction || 200;
  const efSearch = hnswConfig.efSearch || 50;

  hnswIndex = new HierarchicalNSW('cosine', dimensions);

  const loadedFromFile = await loadHNSWFromFile(hnswConfig.maxElements, m, efConstruction);

  if (!loadedFromFile) {
    hnswIndex.initIndex(hnswConfig.maxElements, m, efConstruction);
    await loadExistingVectors();

    // Save index to file asynchronously (non-blocking)
    if (chunkIdToLabel.size > 0) {
      saveHNSWToFile().catch((err) => {
        log('⚠ Background HNSW index save failed:', err);
      });
    }
  }

  hnswIndex.setEf(efSearch);
  isInitialized = true;
  log('✓ Worker initialization complete');
}

/**
 * Loads HNSW index and mapping table from file.
 * Returns true if load was successful.
 */
async function loadHNSWFromFile(
  maxElements: number,
  m: number,
  efConstruction: number
): Promise<boolean> {
  if (!hnswIndex || !hnswIndexPath || !hnswMappingPath) return false;

  try {
    const fs = await import('fs/promises');

    try {
      await fs.access(hnswIndexPath);
      await fs.access(hnswMappingPath);
    } catch {
      log('HNSW index files not found, will rebuild from database');
      return false;
    }

    const startTime = Date.now();
    log('Loading HNSW index from file...');

    const mappingJson = await fs.readFile(hnswMappingPath, 'utf-8');
    const mappingData = JSON.parse(mappingJson) as {
      dimensions: number;
      chunkIdToLabel: [string, number][];
      labelToLibraryId: [number, string][];
      currentLabel: number;
    };

    if (mappingData.dimensions !== dimensions) {
      log(
        `⚠ Dimension mismatch (file: ${mappingData.dimensions}, config: ${dimensions}), will rebuild`
      );
      return false;
    }

    hnswIndex.initIndex(maxElements, m, efConstruction);
    hnswIndex.readIndex(hnswIndexPath);

    chunkIdToLabel = new Map(mappingData.chunkIdToLabel);
    labelToChunkId = new Map(mappingData.chunkIdToLabel.map(([k, v]) => [v, k]));
    labelToLibraryId = new Map(mappingData.labelToLibraryId);
    currentLabel = mappingData.currentLabel;

    const loadTime = Date.now() - startTime;
    log(`✓ HNSW index loaded from file (${chunkIdToLabel.size} vectors, ${loadTime}ms)`);

    return true;
  } catch (err) {
    log('Failed to load HNSW index from file:', err);
    chunkIdToLabel.clear();
    labelToChunkId.clear();
    labelToLibraryId.clear();
    currentLabel = 0;
    return false;
  }
}

/**
 * Saves HNSW index and mapping table to file.
 */
async function saveHNSWToFile(): Promise<void> {
  if (!hnswIndex || !hnswIndexPath || !hnswMappingPath) return;

  try {
    const fs = await import('fs/promises');
    const startTime = Date.now();

    log('Saving HNSW index to file...');

    hnswIndex.writeIndex(hnswIndexPath);

    const mappingData = {
      dimensions,
      chunkIdToLabel: Array.from(chunkIdToLabel.entries()),
      labelToLibraryId: Array.from(labelToLibraryId.entries()),
      currentLabel,
    };
    await fs.writeFile(hnswMappingPath, JSON.stringify(mappingData), 'utf-8');

    const saveTime = Date.now() - startTime;
    log(`✓ HNSW index saved to file (${saveTime}ms)`);
  } catch (err) {
    log('Failed to save HNSW index:', err);
  }
}

/**
 * Index save scheduler (delayed batch save to avoid frequent disk writes).
 *
 * Why debounce strategy?
 * - Users may add multiple documents consecutively; saving each time causes I/O pressure.
 * - HNSW index files are large (~500MB for 100k vectors), writes are noticeable.
 * - 5 second delay balances data safety and performance.
 *
 * Risk: Unexpected process exit may lose last 5 seconds of index updates.
 * Mitigation: Missing vectors are rebuilt from database on restart.
 */
let saveScheduled = false;
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DELAY_MS = 5000; // Save after 5 seconds

/**
 * Schedules index save.
 * Multiple calls trigger only one save (debounced).
 */
function scheduleIndexSave(): void {
  if (saveScheduled) return;

  saveScheduled = true;

  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }

  pendingSaveTimer = setTimeout(async () => {
    saveScheduled = false;
    pendingSaveTimer = null;

    try {
      await saveHNSWToFile();
    } catch (err) {
      log('Scheduled HNSW index save failed:', err);
    }
  }, SAVE_DELAY_MS);
}

/**
 * Clears timers and immediately saves index.
 * Used for graceful Worker shutdown.
 */
async function flushAndClose(): Promise<void> {
  log('Starting graceful shutdown...');

  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  saveScheduled = false;

  if (chunkIdToLabel.size > 0) {
    try {
      await saveHNSWToFile();
      log('✓ Index saved');
    } catch (err) {
      log('Failed to save index on shutdown:', err);
    }
  }

  if (db) {
    try {
      db.close();
      db = null;
      log('✓ Database connection closed');
    } catch (err) {
      log('Failed to close database:', err);
    }
  }

  isInitialized = false;
  log('✓ Worker graceful shutdown complete');
}

/**
 * Loads existing vectors from database into HNSW index.
 * Uses Float32Array for memory and performance optimization.
 */
async function loadExistingVectors(): Promise<void> {
  if (!db || !hnswIndex) return;

  log('Loading existing vectors into HNSW index...');

  const stmt = db.prepare(`
    SELECT chunk_id, library_id, embedding, dimension
    FROM embeddings
  `);

  const rows = stmt.all() as Array<{
    chunk_id: string;
    library_id: string;
    embedding: Buffer;
    dimension: number;
  }>;

  log(`Found ${rows.length} vectors`);

  let loadedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    if (row.dimension !== dimensions) {
      skippedCount++;
      continue;
    }

    // Use Float32Array directly, avoid intermediate number[]
    const float32Embedding = bufferToFloat32Array(row.embedding);
    const label = currentLabel++;

    try {
      // hnswlib-node requires number[], use Array.from to convert
      hnswIndex.addPoint(Array.from(float32Embedding), label);

      chunkIdToLabel.set(row.chunk_id, label);
      labelToChunkId.set(label, row.chunk_id);
      labelToLibraryId.set(label, row.library_id);
      loadedCount++;
    } catch (err) {
      log('Failed to add vector:', row.chunk_id, err);
    }
  }

  log(`✓ Loaded ${loadedCount} vectors into HNSW index`);
  if (skippedCount > 0) {
    log(`⚠ Skipped ${skippedCount} vectors with mismatched dimensions`);
  }
}

/**
 * Vector search using HNSW index.
 * Supports Float32Array, number[], and ArrayBuffer+length (zero-copy Transferable).
 */
function searchByVector(options: VectorSearchOptions): Array<{ chunkId: string; score: number }> {
  const {
    embedding,
    embeddingBuffer,
    embeddingLength,
    libraryIds,
    topK = 10,
    threshold = 0.3,
    excludeChunkIds = [],
  } = options;

  if (!hnswIndex || !isInitialized) {
    log('⚠ HNSW index not initialized');
    return [];
  }

  const indexSize = hnswIndex.getCurrentCount();
  if (indexSize === 0) {
    log('⚠ HNSW index is empty');
    return [];
  }

  let embeddingArray: number[];
  if (embeddingBuffer && embeddingLength) {
    const float32 = new Float32Array(embeddingBuffer);
    embeddingArray = Array.from(float32);
  } else if (embedding) {
    embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
  } else {
    log('⚠ Missing embedding data');
    return [];
  }

  // Search more candidates for post-filtering
  const searchK = Math.min(topK * 3, indexSize);

  try {
    const result = hnswIndex.searchKnn(embeddingArray, searchK);
    const { neighbors, distances } = result;

    const results: Array<{ chunkId: string; score: number }> = [];
    const excludeSet = new Set(excludeChunkIds);
    const librarySet = libraryIds && libraryIds.length > 0 ? new Set(libraryIds) : null;

    for (let i = 0; i < neighbors.length; i++) {
      const label = neighbors[i];
      const chunkId = labelToChunkId.get(label);
      const libraryId = labelToLibraryId.get(label);

      if (!chunkId) continue;
      if (excludeSet.has(chunkId)) continue;
      if (librarySet && libraryId && !librarySet.has(libraryId)) continue;

      // hnswlib returns distance; for cosine: similarity = 1 - distance
      const score = 1 - distances[i];

      if (score >= threshold) {
        results.push({ chunkId, score });
      }

      if (results.length >= topK) break;
    }

    return results;
  } catch (err) {
    log('HNSW search failed:', err);
    return [];
  }
}

/** Inserts a single embedding vector. */
function insertEmbedding(
  chunkId: string,
  libraryId: string,
  embedding: Float32Array | number[],
  model?: string
): void {
  if (!db || !hnswIndex) {
    throw new Error('Worker not initialized');
  }

  const float32Embedding = ensureFloat32Array(embedding);

  if (float32Embedding.length !== dimensions) {
    throw new Error(`Dimension mismatch: expected ${dimensions}, got ${float32Embedding.length}`);
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO embeddings (chunk_id, library_id, embedding, dimension, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    chunkId,
    libraryId,
    float32ArrayToBuffer(float32Embedding),
    float32Embedding.length,
    model || null,
    Date.now()
  );

  let label = chunkIdToLabel.get(chunkId);
  if (label === undefined) {
    label = currentLabel++;
    chunkIdToLabel.set(chunkId, label);
    labelToChunkId.set(label, chunkId);
    labelToLibraryId.set(label, libraryId);
  }

  try {
    // hnswlib-node requires number[]
    hnswIndex.addPoint(Array.from(float32Embedding), label);
  } catch (_err) {
    log('Failed to add point (may already exist):', chunkId);
  }
}

type EmbeddingItem = {
  chunkId: string;
  libraryId: string;
  embedding: Float32Array | number[];
  model?: string;
};

/** Batch inserts embedding vectors. Supports zero-copy transfer. */
function insertEmbeddingsBatch(items: EmbeddingItem[] | SerializedEmbeddingItem[]): void {
  if (!db || !hnswIndex) {
    throw new Error('Worker not initialized');
  }

  log(`Batch inserting ${items.length} vectors`);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO embeddings (chunk_id, library_id, embedding, dimension, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((insertItems: (EmbeddingItem | SerializedEmbeddingItem)[]) => {
    const now = Date.now();
    for (const item of insertItems) {
      let embedding: Float32Array;
      let chunkId: string;
      let libraryId: string;
      let model: string | undefined;

      if ('embeddingBuffer' in item) {
        embedding = arrayBufferToFloat32(item.embeddingBuffer);
        chunkId = item.chunkId;
        libraryId = item.libraryId;
        model = item.model;
      } else {
        embedding = ensureFloat32Array(item.embedding);
        chunkId = item.chunkId;
        libraryId = item.libraryId;
        model = item.model;
      }

      if (embedding.length !== dimensions) {
        log(
          `Skipping vector with mismatched dimensions: ${chunkId} (${embedding.length} vs ${dimensions})`
        );
        continue;
      }

      stmt.run(
        chunkId,
        libraryId,
        float32ArrayToBuffer(embedding),
        embedding.length,
        model || null,
        now
      );

      let label = chunkIdToLabel.get(chunkId);
      if (label === undefined) {
        label = currentLabel++;
        chunkIdToLabel.set(chunkId, label);
        labelToChunkId.set(label, chunkId);
        labelToLibraryId.set(label, libraryId);
      }

      try {
        // hnswlib-node requires number[]
        hnswIndex!.addPoint(Array.from(embedding), label);
      } catch {
        // Ignore duplicate add errors
      }
    }
  });

  insertMany(items);
  log('✓ Batch insert complete');

  // Async save to avoid blocking return
  scheduleIndexSave();
}

/** Rebuilds the HNSW index from database. */
async function rebuildIndex(config: HNSWConfig): Promise<void> {
  log('Rebuilding HNSW index...');

  dimensions = config.dimensions;

  chunkIdToLabel.clear();
  labelToChunkId.clear();
  labelToLibraryId.clear();
  currentLabel = 0;

  const m = config.m || 16;
  const efConstruction = config.efConstruction || 200;
  const efSearch = config.efSearch || 50;

  hnswIndex = new HierarchicalNSW('cosine', dimensions);
  hnswIndex.initIndex(config.maxElements, m, efConstruction);
  hnswIndex.setEf(efSearch);

  await loadExistingVectors();
  await saveHNSWToFile();

  log('✓ HNSW index rebuild complete');
}

/** Gets index statistics. */
function getStats(): {
  isInitialized: boolean;
  indexSize: number;
  dimensions: number;
  mappingSize: number;
} {
  return {
    isInitialized,
    indexSize: hnswIndex?.getCurrentCount() || 0,
    dimensions,
    mappingSize: chunkIdToLabel.size,
  };
}

// ============ Message Handling ============

parentPort?.on('message', async (message: WorkerMessage) => {
  const { id, type, payload } = message;

  try {
    let result: any;

    switch (type) {
      case 'init':
        await initialize(payload);
        result = { success: true };
        break;

      case 'search':
        result = searchByVector(payload);
        break;

      case 'insert':
        insertEmbedding(payload.chunkId, payload.libraryId, payload.embedding, payload.model);
        result = { success: true };
        break;

      case 'insertBatch':
        insertEmbeddingsBatch(payload.items);
        result = { success: true };
        break;

      case 'rebuild':
        await rebuildIndex(payload);
        result = { success: true };
        break;

      case 'getStats':
        result = getStats();
        break;

      case 'close':
        await flushAndClose();
        result = { success: true };
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    sendResponse({ id, success: true, data: result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('Message handling failed:', type, errorMessage);
    sendResponse({ id, success: false, error: errorMessage });
  }
});

// ============ Process Exit Handling ============

// Ensure index is saved on unexpected exit
process.on('beforeExit', async () => {
  if (isInitialized && chunkIdToLabel.size > 0) {
    log('beforeExit detected, saving index...');
    await flushAndClose();
  }
});

process.on('SIGTERM', async () => {
  log('SIGTERM received');
  await flushAndClose();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('SIGINT received');
  await flushAndClose();
  process.exit(0);
});

log('Worker thread started');
