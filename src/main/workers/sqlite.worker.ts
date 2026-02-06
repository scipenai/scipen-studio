/**
 * SQLite Worker
 *
 * Executes time-consuming SQLite operations in a separate thread to avoid blocking the main process
 * Mainly used for bulk data operations like knowledge base deletion
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { parentPort } from 'worker_threads';

// Worker logger - only outputs errors in production mode
const isDev = process.env.NODE_ENV === 'development';
const log = {
  debug: (...args: unknown[]): void => {
    if (isDev) console.debug('[SQLiteWorker]', ...args);
  },
  info: (...args: unknown[]): void => {
    if (isDev) console.info('[SQLiteWorker]', ...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn('[SQLiteWorker]', ...args);
  },
  error: (...args: unknown[]): void => {
    console.error('[SQLiteWorker]', ...args);
  },
};

// ============ Type Definitions ============

/** All supported operation types */
type SQLiteOperationType =
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

/** Worker message - simplified type, maintains runtime safety */
interface WorkerMessage {
  id: string;
  type: SQLiteOperationType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any; // Runtime handled by switch branches for specific types
}

// ============ Read Operation Type Definitions ============

/** Document data (simplified version, for Worker return) */
interface DocumentData {
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

/** Chunk data (simplified version, for Worker return) */
interface ChunkData {
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

/** FTS search results */
interface FTSSearchResult {
  chunkId: string;
  libraryId: string;
  content: string;
  score: number;
}

/** Search result data (includes document information) */
interface SearchResultData {
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

// Chunk data type (simplified version, for Worker)
interface ChunkDataInput {
  content: string;
  chunkType: string;
  metadata: Record<string, any>;
  embedding?: number[];
}

// Input parameters for creating chunks
interface CreateChunksPayload {
  documentId: string;
  libraryId: string;
  chunks: ChunkDataInput[];
}

// Return data for creating chunks
interface CreatedChunk {
  id: string;
  documentId: string;
  libraryId: string;
  content: string;
  contentHash: string;
  chunkIndex: number;
  chunkType: string;
}

// Embedding data type - supports two formats
interface EmbeddingItem {
  chunkId: string;
  libraryId: string;
  embedding: number[];
  model?: string;
}

// Serialized embedding data type (for zero-copy transfer)
interface SerializedEmbeddingItem {
  chunkId: string;
  libraryId: string;
  embeddingBuffer: ArrayBuffer; // ArrayBuffer for zero-copy transfer
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

// ============ Worker State ============

let db: Database.Database | null = null;
let isInitialized = false;

// ============ Utility Functions ============

/**
 * Send response to main process
 */
function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

/**
 * Send progress update to main process
 */
function sendProgress(id: string, progress: number, message: string): void {
  const progressMsg: ProgressMessage = {
    id,
    type: 'progress',
    progress,
    message,
  };
  parentPort?.postMessage(progressMsg);
}

/**
 * Check and log SQLITE_BUSY errors
 *
 * Although busy_timeout = 5000 is configured, timeout may still occur in extreme cases
 * This function tracks such exceptional cases for subsequent troubleshooting
 */
function checkAndLogBusyError(error: unknown, operation: string): void {
  if (error && typeof error === 'object' && 'code' in error) {
    const sqliteError = error as { code?: string; message?: string };
    if (sqliteError.code === 'SQLITE_BUSY') {
      log.warn(
        `⚠️ SQLITE_BUSY error in ${operation} - Database lock timeout exceeded (5s). Consider reducing concurrent operations or increasing busy_timeout. Error: ${sqliteError.message || 'Unknown'}`
      );
    }
  }
}

/**
 * Unified error handling function
 */
function handleError(id: string, error: unknown, operation: string): void {
  // Check if it's a SQLITE_BUSY error
  checkAndLogBusyError(error, operation);

  // Log error
  log.error(`✗ ${operation} failed:`, error);

  // Send error response
  sendResponse({
    id,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

// ============ Operation Handlers ============

/**
 * Initialize database connection
 */
function handleInit(id: string, payload: { dbPath: string }): void {
  try {
    if (isInitialized && db) {
      log.info(' Already initialized, skipping');
      sendResponse({ id, success: true });
      return;
    }

    log.info(' Initializing database connection:', payload.dbPath);
    db = new Database(payload.dbPath, { readonly: false });

    // Enable WAL mode to improve concurrent performance
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Set busy_timeout - automatically retry when database is locked, wait up to 5 seconds
    // This significantly reduces SQLITE_BUSY errors in high concurrency scenarios
    db.pragma('busy_timeout = 5000');

    isInitialized = true;
    log.info(' ✓ Database connection successful');
    sendResponse({ id, success: true });
  } catch (error) {
    log.error(' ✗ Initialization failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Initialize database table structure (create all required tables)
 */
function handleInitDatabase(id: string): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  try {
    log.info(' Initializing database table structure...');

    // Libraries table
    db.exec(`
      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        chunking_config TEXT NOT NULL,
        embedding_config TEXT NOT NULL,
        retrieval_config TEXT NOT NULL,
        document_count INTEGER DEFAULT 0,
        chunk_count INTEGER DEFAULT 0,
        total_size INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Documents table
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bib_key TEXT,
        citation_text TEXT,
        process_status TEXT DEFAULT 'pending',
        processed_at INTEGER,
        error_message TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(process_status);
      CREATE INDEX IF NOT EXISTS idx_documents_media_type ON documents(media_type);
    `);

    // Chunks table
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        library_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_type TEXT NOT NULL,
        start_offset INTEGER,
        end_offset INTEGER,
        prev_chunk_id TEXT,
        next_chunk_id TEXT,
        parent_chunk_id TEXT,
        chunk_metadata TEXT,
        is_enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_library ON chunks(library_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type);
    `);

    // Vector embeddings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE,
        library_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embeddings(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_library ON embeddings(library_id);
    `);

    // FTS5 full-text search table
    let ftsTableCreated = false;
    try {
      db.prepare('SELECT COUNT(*) as count FROM chunks_fts LIMIT 1').get();
    } catch (_e) {
      try {
        db.exec('DROP TABLE IF EXISTS chunks_fts');
      } catch (_dropErr) {
        // ignore
      }
      db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          content,
          chunk_id UNINDEXED,
          library_id UNINDEXED,
          tokenize='porter unicode61'
        );
      `);
      ftsTableCreated = true;
    }

    log.info(' ✓ Database table structure initialization complete');
    sendResponse({ id, success: true, data: { ftsTableCreated } });
  } catch (error) {
    log.error(' ✗ Table structure initialization failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Delete knowledge base - execute in batches, report progress
 */
function handleDeleteLibrary(id: string, payload: { libraryId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { libraryId } = payload;
  const batchSize = 500; // Process 500 items per batch

  try {
    log.info(`Starting deletion of knowledge base: ${libraryId}`);

    // 1. Count totals
    const ftsCount =
      (
        db
          .prepare('SELECT COUNT(*) as count FROM chunks_fts WHERE library_id = ?')
          .get(libraryId) as { count: number }
      )?.count || 0;

    const embeddingCount =
      (
        db
          .prepare('SELECT COUNT(*) as count FROM embeddings WHERE library_id = ?')
          .get(libraryId) as { count: number }
      )?.count || 0;

    const chunkCount =
      (
        db.prepare('SELECT COUNT(*) as count FROM chunks WHERE library_id = ?').get(libraryId) as {
          count: number;
        }
      )?.count || 0;

    const docCount =
      (
        db
          .prepare('SELECT COUNT(*) as count FROM documents WHERE library_id = ?')
          .get(libraryId) as { count: number }
      )?.count || 0;

    const totalWork = ftsCount + embeddingCount + chunkCount + docCount + 1;
    let completedWork = 0;

    log.info(
      `To delete: FTS=${ftsCount}, Embeddings=${embeddingCount}, Chunks=${chunkCount}, Docs=${docCount}`
    );

    // Helper function to report progress
    const reportProgress = (message: string) => {
      const progress = totalWork > 0 ? Math.round((completedWork / totalWork) * 100) : 0;
      sendProgress(id, Math.min(progress, 99), message);
    };

    // 2. Delete FTS records
    reportProgress(`Cleaning search index (0/${ftsCount})`);
    let deletedFts = 0;
    while (true) {
      const rowids = db
        .prepare('SELECT rowid FROM chunks_fts WHERE library_id = ? LIMIT ?')
        .all(libraryId, batchSize) as { rowid: number }[];

      if (rowids.length === 0) break;

      const placeholders = rowids.map(() => '?').join(',');
      db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (${placeholders})`).run(
        ...rowids.map((r) => r.rowid)
      );

      deletedFts += rowids.length;
      completedWork += rowids.length;
      reportProgress(`Cleaning search index (${deletedFts}/${ftsCount})`);
    }
    log.info(`✓ FTS records deleted: ${deletedFts}`);

    // 3. Delete embedding records
    reportProgress(`Cleaning vector embeddings (0/${embeddingCount})`);
    let deletedEmb = 0;
    while (true) {
      const ids = db
        .prepare('SELECT chunk_id FROM embeddings WHERE library_id = ? LIMIT ?')
        .all(libraryId, batchSize) as { chunk_id: string }[];

      if (ids.length === 0) break;

      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(
        ...ids.map((r) => r.chunk_id)
      );

      deletedEmb += ids.length;
      completedWork += ids.length;
      reportProgress(`Cleaning vector embeddings (${deletedEmb}/${embeddingCount})`);
    }
    log.info(`✓ Embedding records deleted: ${deletedEmb}`);

    // 4. Delete chunks
    reportProgress(`Cleaning document chunks (0/${chunkCount})`);
    let deletedChunks = 0;
    while (true) {
      const ids = db
        .prepare('SELECT id FROM chunks WHERE library_id = ? LIMIT ?')
        .all(libraryId, batchSize) as { id: string }[];

      if (ids.length === 0) break;

      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids.map((r) => r.id));

      deletedChunks += ids.length;
      completedWork += ids.length;
      reportProgress(`Cleaning document chunks (${deletedChunks}/${chunkCount})`);
    }
    log.info(`✓ Chunks deleted: ${deletedChunks}`);

    // 5. Delete documents
    reportProgress(`Cleaning document records (${docCount})`);
    db.prepare('DELETE FROM documents WHERE library_id = ?').run(libraryId);
    completedWork += docCount;
    log.info(' ✓ Documents deleted');

    // 6. Delete library entry
    reportProgress('Cleanup complete');
    const result = db.prepare('DELETE FROM libraries WHERE id = ?').run(libraryId);
    completedWork += 1;
    log.info(' ✓ Knowledge base deletion complete');

    // Send 100% completion
    sendProgress(id, 100, 'Deletion complete');

    sendResponse({
      id,
      success: true,
      data: { deleted: result.changes > 0 },
    });
  } catch (error) {
    log.error(' ✗ Knowledge base deletion failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Delete document - also delete associated chunks, embeddings, and FTS index
 */
function handleDeleteDocument(id: string, payload: { documentId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { documentId } = payload;

  try {
    log.info(`Starting deletion of document: ${documentId}`);
    sendProgress(id, 0, 'Starting document deletion...');

    // 0. First get document info (including file path) to return to main thread for file deletion
    const docInfo = db
      .prepare('SELECT file_path, library_id FROM documents WHERE id = ?')
      .get(documentId) as { file_path: string; library_id: string } | undefined;

    if (!docInfo) {
      sendResponse({ id, success: true, data: { deleted: false, filePath: null } });
      return;
    }

    // 1. Get chunk IDs associated with the document
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as {
      id: string;
    }[];

    log.info(`Document associated chunks: ${chunkIds.length}`);
    sendProgress(id, 10, `Found ${chunkIds.length} chunks`);

    if (chunkIds.length > 0) {
      const chunkIdList = chunkIds.map((c) => c.id);

      // 2. Delete FTS index
      sendProgress(id, 20, 'Deleting search index...');
      const placeholders = chunkIdList.map(() => '?').join(',');
      db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`).run(...chunkIdList);
      log.info(' ✓ FTS index deleted');

      // 3. Delete embedding vectors
      sendProgress(id, 40, 'Deleting vector embeddings...');
      db.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIdList);
      log.info(' ✓ Embedding vectors deleted');

      // 4. Delete chunks
      sendProgress(id, 60, 'Deleting chunks...');
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
      log.info(' ✓ Chunks deleted');
    }

    // 5. Delete document record
    sendProgress(id, 80, 'Deleting document record...');
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
    log.info(' ✓ Document record deleted');

    // 6. Update library statistics
    sendProgress(id, 90, 'Updating statistics...');
    updateLibraryStats(docInfo.library_id);

    sendProgress(id, 100, 'Deletion complete');
    log.info(' ✓ Document deletion complete');

    sendResponse({
      id,
      success: true,
      data: { deleted: result.changes > 0, filePath: docInfo.file_path },
    });
  } catch (error) {
    log.error(' ✗ Document deletion failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Update library statistics
 */
function updateLibraryStats(libraryId: string): void {
  if (!db) return;

  try {
    const docCount =
      (
        db
          .prepare('SELECT COUNT(*) as count FROM documents WHERE library_id = ?')
          .get(libraryId) as { count: number }
      )?.count || 0;

    const chunkCount =
      (
        db.prepare('SELECT COUNT(*) as count FROM chunks WHERE library_id = ?').get(libraryId) as {
          count: number;
        }
      )?.count || 0;

    db.prepare(`
      UPDATE libraries
      SET document_count = ?, chunk_count = ?, updated_at = ?
      WHERE id = ?
    `).run(docCount, chunkCount, Date.now(), libraryId);
  } catch (e) {
    log.error(' Statistics update failed:', e);
  }
}

/**
 * Delete all chunks of a document
 */
function handleDeleteChunksByDocument(id: string, payload: { documentId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { documentId } = payload;

  try {
    log.info(`Deleting document chunks: ${documentId}`);

    // Get chunk IDs
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as {
      id: string;
    }[];

    if (chunkIds.length > 0) {
      const chunkIdList = chunkIds.map((c) => c.id);
      const placeholders = chunkIdList.map(() => '?').join(',');

      // Delete FTS index
      db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`).run(...chunkIdList);

      // Delete embedding vectors
      db.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIdList);
    }

    // Delete chunks
    const result = db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
    log.info(`✓ Deleted ${result.changes} chunks`);

    sendResponse({
      id,
      success: true,
      data: { count: result.changes },
    });
  } catch (error) {
    log.error(' ✗ Chunk deletion failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generate unique ID
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Compute content hash
 */
function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Convert float array to Buffer (for storing embedding vectors)
 * Supports Float32Array and number[] input
 */
function float32ArrayToBuffer(arr: Float32Array | number[]): Buffer {
  const float32 = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Create Float32Array from ArrayBuffer (for zero-copy reception)
 */
function arrayBufferToFloat32(buffer: ArrayBuffer): Float32Array {
  return new Float32Array(buffer);
}

/**
 * Create chunks - executed in Worker thread, doesn't block main thread
 */
function handleCreateChunks(id: string, payload: CreateChunksPayload): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { documentId, libraryId, chunks } = payload;
  const now = Date.now();
  const createdChunks: CreatedChunk[] = [];

  try {
    log.info(`Starting chunk creation: ${chunks.length} chunks`);
    sendProgress(id, 0, `Creating chunks (0/${chunks.length})`);

    const insertStmt = db.prepare(`
      INSERT INTO chunks (
        id, document_id, library_id, content, content_hash,
        chunk_index, chunk_type, start_offset, end_offset,
        prev_chunk_id, next_chunk_id, parent_chunk_id,
        chunk_metadata, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFtsStmt = db.prepare(`
      INSERT INTO chunks_fts (content, chunk_id, library_id)
      VALUES (?, ?, ?)
    `);

    const updateNextStmt = db.prepare(`
      UPDATE chunks SET next_chunk_id = ? WHERE id = ?
    `);

    // Use transaction for batch insertion
    const insertMany = db.transaction((chunksToInsert: ChunkDataInput[]) => {
      let prevChunkId: string | undefined;

      for (let i = 0; i < chunksToInsert.length; i++) {
        const chunkData = chunksToInsert[i];
        const chunkId = generateId('chunk');
        const contentHash = computeHash(chunkData.content);

        insertStmt.run(
          chunkId,
          documentId,
          libraryId,
          chunkData.content,
          contentHash,
          i, // chunk_index
          chunkData.chunkType,
          chunkData.metadata.startOffset || null,
          chunkData.metadata.endOffset || null,
          prevChunkId || null,
          null, // nextChunkId - will be updated later
          null, // parentChunkId
          JSON.stringify(chunkData.metadata),
          1, // is_enabled
          now,
          now
        );

        // Update previous chunk's nextChunkId
        if (prevChunkId) {
          updateNextStmt.run(chunkId, prevChunkId);
        }

        // Insert FTS index
        insertFtsStmt.run(chunkData.content, chunkId, libraryId);

        prevChunkId = chunkId;
        createdChunks.push({
          id: chunkId,
          documentId,
          libraryId,
          content: chunkData.content,
          contentHash,
          chunkIndex: i,
          chunkType: chunkData.chunkType,
        });

        // Report progress every 50 chunks
        if ((i + 1) % 50 === 0 || i === chunksToInsert.length - 1) {
          const progress = Math.round(((i + 1) / chunksToInsert.length) * 100);
          sendProgress(id, progress, `Creating chunks (${i + 1}/${chunksToInsert.length})`);
        }
      }
    });

    insertMany(chunks);
    log.info(`✓ Chunk creation complete: ${createdChunks.length} chunks`);

    sendResponse({
      id,
      success: true,
      data: { chunks: createdChunks },
    });
  } catch (error) {
    handleError(id, error, 'Create chunks');
  }
}

/**
 * Batch insert embedding vectors - executed in Worker thread
 * Supports two formats: normal format and serialized format (zero-copy transfer)
 */
function handleInsertEmbeddings(
  id: string,
  payload: { items: (EmbeddingItem | SerializedEmbeddingItem)[] }
): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { items } = payload;
  const now = Date.now();

  try {
    log.info(`Starting embedding insertion: ${items.length} items`);
    sendProgress(id, 0, `Inserting embeddings (0/${items.length})`);

    // Don't specify id, let SQLite auto-generate AUTOINCREMENT value
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO embeddings (
        chunk_id, library_id, embedding, model, dimension, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Use transaction for batch insertion
    const insertMany = db.transaction(
      (embeddingsToInsert: (EmbeddingItem | SerializedEmbeddingItem)[]) => {
        for (let i = 0; i < embeddingsToInsert.length; i++) {
          const item = embeddingsToInsert[i];
          let embeddingBuffer: Buffer;
          let dimensions: number;
          let chunkId: string;
          let libraryId: string;
          let model: string | undefined;

          // Handle two formats
          if ('embeddingBuffer' in item) {
            // Serialized format (zero-copy transfer) - create directly from ArrayBuffer
            const float32 = arrayBufferToFloat32(item.embeddingBuffer);
            embeddingBuffer = float32ArrayToBuffer(float32);
            dimensions = item.dimensions;
            chunkId = item.chunkId;
            libraryId = item.libraryId;
            model = item.model;
          } else {
            // Normal format
            embeddingBuffer = float32ArrayToBuffer(item.embedding);
            dimensions = item.embedding.length;
            chunkId = item.chunkId;
            libraryId = item.libraryId;
            model = item.model;
          }

          insertStmt.run(chunkId, libraryId, embeddingBuffer, model || 'unknown', dimensions, now);

          // Report progress every 100 embeddings
          if ((i + 1) % 100 === 0 || i === embeddingsToInsert.length - 1) {
            const progress = Math.round(((i + 1) / embeddingsToInsert.length) * 100);
            sendProgress(
              id,
              progress,
              `Inserting embeddings (${i + 1}/${embeddingsToInsert.length})`
            );
          }
        }
      }
    );

    insertMany(items);
    log.info(`✓ Embedding insertion complete: ${items.length} items`);

    sendResponse({
      id,
      success: true,
      data: { count: items.length },
    });
  } catch (error) {
    handleError(id, error, 'Insert embeddings');
  }
}

// ============ Read Operation Handlers ============

/**
 * Get all documents in a library
 */
function handleGetDocuments(id: string, payload: { libraryId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { libraryId } = payload;

  try {
    log.info(`Querying document list: libraryId=${libraryId}`);

    const stmt = db.prepare(`
      SELECT * FROM documents 
      WHERE library_id = ? 
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(libraryId) as any[];

    const documents: DocumentData[] = rows.map((row) => ({
      id: row.id,
      libraryId: row.library_id,
      filename: row.filename,
      filePath: row.file_path,
      fileSize: row.file_size,
      fileHash: row.file_hash,
      mediaType: row.media_type,
      mimeType: row.mime_type,
      bibKey: row.bib_key,
      citationText: row.citation_text,
      processStatus: row.process_status,
      processedAt: row.processed_at,
      errorMessage: row.error_message,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    log.info(`✓ Found ${documents.length} documents`);

    sendResponse({
      id,
      success: true,
      data: { documents },
    });
  } catch (error) {
    log.error(' ✗ Document query failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get all chunks of a document
 */
function handleGetChunks(id: string, payload: { documentId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { documentId } = payload;

  try {
    log.info(`Querying chunk list: documentId=${documentId}`);

    const stmt = db.prepare(`
      SELECT * FROM chunks 
      WHERE document_id = ? 
      ORDER BY chunk_index ASC
    `);
    const rows = stmt.all(documentId) as any[];

    const chunks: ChunkData[] = rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      libraryId: row.library_id,
      content: row.content,
      contentHash: row.content_hash,
      chunkIndex: row.chunk_index,
      chunkType: row.chunk_type,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      prevChunkId: row.prev_chunk_id,
      nextChunkId: row.next_chunk_id,
      parentChunkId: row.parent_chunk_id,
      chunkMetadata: row.chunk_metadata ? JSON.parse(row.chunk_metadata) : {},
      isEnabled: row.is_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    log.info(`✓ Found ${chunks.length} chunks`);

    sendResponse({
      id,
      success: true,
      data: { chunks },
    });
  } catch (error) {
    log.error(' ✗ Chunk query failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * FTS5 keyword search
 */
function handleKeywordSearch(
  id: string,
  payload: {
    query: string;
    libraryIds?: string[];
    topK?: number;
  }
): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { query, libraryIds, topK = 20 } = payload;

  try {
    log.info(`FTS keyword search: "${query}", libraries=${libraryIds?.join(',') || 'all'}`);

    // Process query string, supports Chinese and English
    const processedQuery = query
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`)
      .join(' OR ');

    if (!processedQuery) {
      sendResponse({
        id,
        success: true,
        data: { results: [] },
      });
      return;
    }

    let sql: string;
    let params: any[];

    if (libraryIds && libraryIds.length > 0) {
      const placeholders = libraryIds.map(() => '?').join(',');
      sql = `
        SELECT 
          chunk_id,
          library_id,
          content,
          bm25(chunks_fts) as score
        FROM chunks_fts 
        WHERE chunks_fts MATCH ? 
          AND library_id IN (${placeholders})
        ORDER BY score
        LIMIT ?
      `;
      params = [processedQuery, ...libraryIds, topK];
    } else {
      sql = `
        SELECT 
          chunk_id,
          library_id,
          content,
          bm25(chunks_fts) as score
        FROM chunks_fts 
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `;
      params = [processedQuery, topK];
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    const results: FTSSearchResult[] = rows.map((row) => ({
      chunkId: row.chunk_id,
      libraryId: row.library_id,
      content: row.content,
      score: Math.abs(row.score), // BM25 score is negative, take absolute value
    }));

    log.info(`✓ FTS search found ${results.length} results`);

    sendResponse({
      id,
      success: true,
      data: { results },
    });
  } catch (error) {
    log.error(' ✗ FTS search failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get search result details (includes document information)
 */
function handleGetSearchResults(id: string, payload: { chunkIds: string[] }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { chunkIds } = payload;

  if (!chunkIds || chunkIds.length === 0) {
    sendResponse({ id, success: true, data: { results: [] } });
    return;
  }

  try {
    log.info(`Getting search result details: ${chunkIds.length} items`);

    const placeholders = chunkIds.map(() => '?').join(',');
    const stmt = db.prepare(`
      SELECT
        c.id,
        c.document_id,
        c.library_id,
        c.content,
        c.chunk_metadata,
        d.filename,
        d.media_type,
        d.bib_key,
        d.citation_text
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.id IN (${placeholders})
    `);

    const rows = stmt.all(...chunkIds) as any[];
    const resultMap = new Map<string, any>();

    for (const row of rows) {
      resultMap.set(row.id, row);
    }

    // Preserve original order
    const results: SearchResultData[] = chunkIds
      .map((chunkId) => resultMap.get(chunkId))
      .filter(Boolean)
      .map((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        libraryId: row.library_id,
        content: row.content,
        score: 0, // Set by caller
        mediaType: row.media_type,
        filename: row.filename,
        bibKey: row.bib_key,
        citationText: row.citation_text,
        chunkMetadata: row.chunk_metadata ? JSON.parse(row.chunk_metadata) : {},
      }));

    log.info(`✓ Retrieved ${results.length} search results`);

    sendResponse({
      id,
      success: true,
      data: { results },
    });
  } catch (error) {
    log.error(' ✗ Failed to get search results:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get diagnostic information
 */
function handleGetDiagnostics(id: string, payload: { libraryId?: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { libraryId } = payload;

  try {
    log.info(`Getting diagnostic information: libraryId=${libraryId || 'all'}`);

    // Total chunk count
    const chunkCount = (
      db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number }
    ).count;

    // Total embedding count
    const embeddingCount = (
      db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number }
    ).count;

    // FTS record count
    let ftsCount = 0;
    try {
      ftsCount = (db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get() as { count: number })
        .count;
    } catch (_e) {
      log.info(' FTS table query failed');
    }

    // Embedding dimensions
    const dimensions = db.prepare('SELECT DISTINCT dimension FROM embeddings').all() as Array<{
      dimension: number;
    }>;

    // Statistics by library
    let libraryStats: Array<{ library_id: string; chunk_count: number; embedding_count: number }> =
      [];
    if (libraryId) {
      libraryStats = db
        .prepare(`
        SELECT c.library_id, COUNT(DISTINCT c.id) as chunk_count, COUNT(DISTINCT e.chunk_id) as embedding_count
        FROM chunks c LEFT JOIN embeddings e ON c.id = e.chunk_id
        WHERE c.library_id = ? GROUP BY c.library_id
      `)
        .all(libraryId) as typeof libraryStats;
    } else {
      libraryStats = db
        .prepare(`
        SELECT c.library_id, COUNT(DISTINCT c.id) as chunk_count, COUNT(DISTINCT e.chunk_id) as embedding_count
        FROM chunks c LEFT JOIN embeddings e ON c.id = e.chunk_id
        GROUP BY c.library_id
      `)
        .all() as typeof libraryStats;
    }

    const diagnostics = {
      totalChunks: chunkCount,
      totalEmbeddings: embeddingCount,
      ftsRecords: ftsCount,
      embeddingDimensions: dimensions.map((d) => d.dimension),
      libraryStats: libraryStats.map((s) => ({
        libraryId: s.library_id,
        chunks: s.chunk_count,
        embeddings: s.embedding_count,
      })),
    };

    log.info(' ✓ Diagnostic information retrieved');

    sendResponse({
      id,
      success: true,
      data: { diagnostics },
    });
  } catch (error) {
    log.error(' ✗ Failed to get diagnostic information:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get all libraries
 */
function handleGetAllLibraries(id: string): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  try {
    log.info(' Getting all libraries');

    const stmt = db.prepare('SELECT * FROM libraries ORDER BY created_at DESC');
    const rows = stmt.all() as any[];

    const libraries = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      documentCount: row.document_count || 0,
      chunkCount: row.chunk_count || 0,
      totalSize: row.total_size || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    log.info(`✓ Retrieved ${libraries.length} libraries`);

    sendResponse({
      id,
      success: true,
      data: { libraries },
    });
  } catch (error) {
    log.error(' ✗ Failed to get libraries:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Rebuild FTS index
 */
function handleRebuildFTSIndex(id: string): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  try {
    log.info(' Starting FTS index rebuild...');
    sendProgress(id, 0, 'Clearing existing index...');

    // Clear existing FTS data
    db.exec('DELETE FROM chunks_fts');

    // Get total count
    const countResult = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    const total = countResult.count;
    log.info(`Total chunks to index: ${total}`);

    if (total === 0) {
      sendResponse({ id, success: true, data: { count: 0 } });
      return;
    }

    // Prepare statement
    const insertStmt = db.prepare(`
      INSERT INTO chunks_fts (content, chunk_id, library_id)
      VALUES (?, ?, ?)
    `);

    const allChunksStmt = db.prepare('SELECT id, content, library_id FROM chunks');
    const iterator = allChunksStmt.iterate();

    const batchSize = 1000;
    let batch: any[] = [];
    let processed = 0;

    const runBatch = db.transaction((items: any[]) => {
      for (const item of items) {
        insertStmt.run(item.content, item.id, item.library_id);
      }
    });

    for (const chunk of iterator) {
      batch.push(chunk);

      if (batch.length >= batchSize) {
        runBatch(batch);
        processed += batch.length;
        batch = [];
        const progress = Math.round((processed / total) * 100);
        sendProgress(id, progress, `Indexing progress: ${processed}/${total}`);
      }
    }

    // Process remaining
    if (batch.length > 0) {
      runBatch(batch);
      processed += batch.length;
    }

    log.info(' ✓ FTS index rebuild complete, indexed', processed, 'records');
    sendProgress(id, 100, 'Complete');
    sendResponse({ id, success: true, data: { count: processed } });
  } catch (error) {
    log.error(' ✗ FTS index rebuild failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get single chunk
 */
function handleGetChunkById(id: string, payload: { chunkId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { chunkId } = payload;

  try {
    const stmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
    const row = stmt.get(chunkId) as any;

    if (!row) {
      sendResponse({ id, success: true, data: { chunk: null } });
      return;
    }

    const chunk: ChunkData = {
      id: row.id,
      documentId: row.document_id,
      libraryId: row.library_id,
      content: row.content,
      contentHash: row.content_hash,
      chunkIndex: row.chunk_index,
      chunkType: row.chunk_type,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      prevChunkId: row.prev_chunk_id,
      nextChunkId: row.next_chunk_id,
      parentChunkId: row.parent_chunk_id,
      chunkMetadata: row.chunk_metadata ? JSON.parse(row.chunk_metadata) : {},
      isEnabled: row.is_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    sendResponse({ id, success: true, data: { chunk } });
  } catch (error) {
    log.error(' ✗ Failed to get chunk:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Batch get chunks
 */
function handleGetChunksByIds(id: string, payload: { chunkIds: string[] }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { chunkIds } = payload;

  if (!chunkIds || chunkIds.length === 0) {
    sendResponse({ id, success: true, data: { chunks: [] } });
    return;
  }

  try {
    const placeholders = chunkIds.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`);
    const rows = stmt.all(...chunkIds) as any[];

    const chunks: ChunkData[] = rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      libraryId: row.library_id,
      content: row.content,
      contentHash: row.content_hash,
      chunkIndex: row.chunk_index,
      chunkType: row.chunk_type,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      prevChunkId: row.prev_chunk_id,
      nextChunkId: row.next_chunk_id,
      parentChunkId: row.parent_chunk_id,
      chunkMetadata: row.chunk_metadata ? JSON.parse(row.chunk_metadata) : {},
      isEnabled: row.is_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    sendResponse({ id, success: true, data: { chunks } });
  } catch (error) {
    log.error(' ✗ Batch chunk retrieval failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get single document
 */
function handleGetDocumentById(id: string, payload: { documentId: string }): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { documentId } = payload;

  try {
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?');
    const row = stmt.get(documentId) as any;

    if (!row) {
      sendResponse({ id, success: true, data: { document: null } });
      return;
    }

    const document: DocumentData = {
      id: row.id,
      libraryId: row.library_id,
      filename: row.filename,
      filePath: row.file_path,
      fileSize: row.file_size,
      fileHash: row.file_hash,
      mediaType: row.media_type,
      mimeType: row.mime_type,
      bibKey: row.bib_key,
      citationText: row.citation_text,
      processStatus: row.process_status,
      processedAt: row.processed_at,
      errorMessage: row.error_message,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    sendResponse({ id, success: true, data: { document } });
  } catch (error) {
    log.error(' ✗ Failed to get document:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Convert Buffer to float array
 */
function bufferToFloat32Array(buffer: Buffer): number[] {
  const float32 = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(float32);
}

/**
 * Calculate cosine similarity
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Brute-force vector search
 */
function handleVectorSearchBruteForce(
  id: string,
  payload: {
    embedding: number[];
    libraryIds?: string[];
    topK?: number;
    threshold?: number;
    excludeChunkIds?: string[];
  }
): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { embedding, libraryIds, topK = 10, threshold = 0.3, excludeChunkIds = [] } = payload;

  try {
    log.info(' Starting brute-force vector search...');

    // Build query conditions
    let whereClause = '1=1';
    const params: any[] = [];

    if (libraryIds && libraryIds.length > 0) {
      whereClause += ` AND library_id IN (${libraryIds.map(() => '?').join(',')})`;
      params.push(...libraryIds);
    }

    if (excludeChunkIds.length > 0) {
      whereClause += ` AND chunk_id NOT IN (${excludeChunkIds.map(() => '?').join(',')})`;
      params.push(...excludeChunkIds);
    }

    // Get all candidate vectors
    const stmt = db.prepare(`
      SELECT chunk_id, embedding, dimension
      FROM embeddings
      WHERE ${whereClause}
    `);

    const rows = stmt.all(...params) as Array<{
      chunk_id: string;
      embedding: Buffer;
      dimension: number;
    }>;

    log.info(' Candidate vector count:', rows.length);

    if (rows.length === 0) {
      sendResponse({ id, success: true, data: { results: [] } });
      return;
    }

    // Calculate similarity
    const results: Array<{ chunkId: string; score: number }> = [];

    for (const row of rows) {
      const storedEmbedding = bufferToFloat32Array(row.embedding);
      const score = cosineSimilarity(embedding, storedEmbedding);

      if (score >= threshold) {
        results.push({ chunkId: row.chunk_id, score });
      }
    }

    // Sort by score and return TopK
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK);

    log.info(' ✓ Brute-force search complete, found', topResults.length, 'results');
    sendResponse({ id, success: true, data: { results: topResults } });
  } catch (error) {
    log.error(' ✗ Brute-force search failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Insert single embedding vector
 */
function handleInsertEmbeddingSingle(
  id: string,
  payload: {
    chunkId: string;
    libraryId: string;
    embedding: number[];
    model?: string;
  }
): void {
  if (!db || !isInitialized) {
    sendResponse({ id, success: false, error: 'Database not initialized' });
    return;
  }

  const { chunkId, libraryId, embedding, model } = payload;

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO embeddings (chunk_id, library_id, embedding, dimension, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      chunkId,
      libraryId,
      float32ArrayToBuffer(embedding),
      embedding.length,
      model || null,
      Date.now()
    );

    sendResponse({ id, success: true });
  } catch (error) {
    log.error(' ✗ Embedding insertion failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Gracefully close database connection
 * Execute WAL checkpoint to ensure data integrity
 */
function gracefulClose(): void {
  if (!db) return;

  try {
    // Execute WAL checkpoint to ensure all data is written to main database file
    // TRUNCATE mode clears WAL file after checkpoint
    log.info(' Executing WAL checkpoint...');
    db.pragma('wal_checkpoint(TRUNCATE)');
    log.info(' ✓ WAL checkpoint complete');

    // Close database
    db.close();
    db = null;
    isInitialized = false;
    log.info(' ✓ Database connection closed');
  } catch (error) {
    log.error(' ✗ Graceful database close failed:', error);
    // Even if checkpoint fails, try to close connection
    try {
      if (db) {
        db.close();
        db = null;
        isInitialized = false;
      }
    } catch (closeError) {
      log.error(' ✗ Force close database failed:', closeError);
    }
  }
}

/**
 * Close database connection (IPC handler)
 */
function handleClose(id: string): void {
  try {
    gracefulClose();
    sendResponse({ id, success: true });
  } catch (error) {
    log.error(' ✗ Database close failed:', error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============ Message Handling ============

parentPort?.on('message', (message: WorkerMessage) => {
  const { id, type, payload } = message;

  switch (type) {
    case 'init':
      handleInit(id, payload);
      break;
    case 'initDatabase':
      handleInitDatabase(id);
      break;
    case 'deleteLibrary':
      handleDeleteLibrary(id, payload);
      break;
    case 'deleteDocument':
      handleDeleteDocument(id, payload);
      break;
    case 'deleteChunksByDocument':
      handleDeleteChunksByDocument(id, payload);
      break;
    case 'createChunks':
      handleCreateChunks(id, payload);
      break;
    case 'insertEmbeddings':
      handleInsertEmbeddings(id, payload);
      break;
    case 'insertEmbeddingSingle':
      handleInsertEmbeddingSingle(id, payload);
      break;
    // Read operations
    case 'getDocuments':
      handleGetDocuments(id, payload);
      break;
    case 'getChunks':
      handleGetChunks(id, payload);
      break;
    case 'getChunkById':
      handleGetChunkById(id, payload);
      break;
    case 'getChunksByIds':
      handleGetChunksByIds(id, payload);
      break;
    case 'getDocumentById':
      handleGetDocumentById(id, payload);
      break;
    case 'keywordSearch':
      handleKeywordSearch(id, payload);
      break;
    case 'getSearchResults':
      handleGetSearchResults(id, payload);
      break;
    case 'getDiagnostics':
      handleGetDiagnostics(id, payload);
      break;
    case 'getAllLibraries':
      handleGetAllLibraries(id);
      break;
    case 'rebuildFTSIndex':
      handleRebuildFTSIndex(id);
      break;
    case 'vectorSearchBruteForce':
      handleVectorSearchBruteForce(id, payload);
      break;
    case 'close':
      handleClose(id);
      break;
    default:
      sendResponse({
        id,
        success: false,
        error: `Unknown operation type: ${type}`,
      });
  }
});

// ============ Process Exit Handling ============

/**
 * Handle process exit signals
 * Ensure database connection is closed as much as possible on unexpected exit
 */
process.on('beforeExit', () => {
  if (isInitialized && db) {
    log.info(' Detected beforeExit, executing graceful close...');
    gracefulClose();
  }
});

process.on('SIGTERM', () => {
  log.info(' Received SIGTERM signal');
  gracefulClose();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info(' Received SIGINT signal');
  gracefulClose();
  process.exit(0);
});

// Handle uncaught exceptions, try to save data
process.on('uncaughtException', (error) => {
  log.error(' Uncaught exception:', error);
  gracefulClose();
  process.exit(1);
});

log.info(' Worker started');
