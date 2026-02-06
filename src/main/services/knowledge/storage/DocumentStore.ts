/**
 * @file DocumentStore - Document Storage Service
 * @description Manages CRUD operations for knowledge bases, documents, and chunks
 * @depends SQLiteWorkerClient, better-sqlite3
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  type ChunkDataInput,
  type SQLiteWorkerClient,
  getSQLiteWorkerClient,
} from '../../../workers/SQLiteWorkerClient';
import { createLogger } from '../../LoggerService';
import {
  type Chunk,
  type ChunkData,
  type ChunkType,
  type ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  type Document,
  type DocumentMetadata,
  type EmbeddingConfig,
  type KnowledgeBase,
  type MediaType,
  type ProcessStatus,
  type RetrievalConfig,
} from '../types';

const logger = createLogger('DocumentStore');

// ============ Database Row Type Definitions ============

/** Library table row */
interface LibraryRow {
  id: string;
  name: string;
  description: string | null;
  chunking_config: string;
  embedding_config: string;
  retrieval_config: string;
  document_count: number;
  chunk_count: number;
  total_size: number;
  created_at: number;
  updated_at: number;
}

/** Document table row */
interface DocumentRow {
  id: string;
  library_id: string;
  filename: string;
  file_path: string | null;
  file_size: number;
  file_hash: string | null;
  media_type: string;
  mime_type: string | null;
  bib_key: string | null;
  citation_text: string | null;
  process_status: string;
  processed_at: number | null;
  error_message: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

/** Chunk table row */
interface ChunkRow {
  id: string;
  document_id: string;
  library_id: string;
  content: string;
  content_hash: string;
  chunk_index: number;
  chunk_type: string;
  start_offset: number | null;
  end_offset: number | null;
  prev_chunk_id: string | null;
  next_chunk_id: string | null;
  parent_chunk_id: string | null;
  chunk_metadata: string | null;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

/** Library ID row */
interface LibraryIdRow {
  id: string;
}

/** Document statistics row */
interface DocStatsRow {
  doc_count: number;
  total_size: number;
}

/** Chunk statistics row */
interface ChunkStatsRow {
  chunk_count: number;
}

export class DocumentStore {
  private db: Database.Database;
  private sqliteWorkerClient: SQLiteWorkerClient | null = null;
  private workerInitPromise: Promise<void> | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Create synchronous database connection (for existing sync operations)
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // Async initialize Worker, don't block constructor
    this.initWorkerAsync();
  }

  /**
   * Async initialize SQLite Worker
   */
  private async initWorkerAsync(): Promise<void> {
    if (this.workerInitPromise) {
      return this.workerInitPromise;
    }

    this.workerInitPromise = (async () => {
      try {
        logger.info('[DocumentStore] Initializing SQLite Worker...');
        this.sqliteWorkerClient = getSQLiteWorkerClient();
        await this.sqliteWorkerClient.initialize(this.dbPath);
        logger.info('[DocumentStore] ✓ SQLite Worker ready');
      } catch (error) {
        console.warn(
          '[DocumentStore] SQLite Worker initialization failed, will use sync mode:',
          error
        );
        this.sqliteWorkerClient = null;
      }
    })();

    return this.workerInitPromise;
  }

  /**
   * Get Worker client (ensures initialization)
   */
  async getWorkerClient(): Promise<SQLiteWorkerClient | null> {
    await this.workerInitPromise;
    return this.sqliteWorkerClient;
  }

  // ==================== Library Operations ====================

  /**
   * Create knowledge base
   */
  createLibrary(params: {
    name: string;
    description?: string;
    chunkingConfig?: Partial<ChunkingConfig>;
    embeddingConfig?: Partial<EmbeddingConfig>;
    retrievalConfig?: Partial<RetrievalConfig>;
  }): KnowledgeBase {
    const id = this.generateId('lib');
    const now = Date.now();

    const library: KnowledgeBase = {
      id,
      name: params.name,
      description: params.description,
      chunkingConfig: { ...DEFAULT_CHUNKING_CONFIG, ...params.chunkingConfig },
      embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG, ...params.embeddingConfig },
      retrievalConfig: { ...DEFAULT_RETRIEVAL_CONFIG, ...params.retrievalConfig },
      documentCount: 0,
      chunkCount: 0,
      totalSize: 0,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO libraries (
        id, name, description,
        chunking_config, embedding_config, retrieval_config,
        document_count, chunk_count, total_size,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      library.id,
      library.name,
      library.description || null,
      JSON.stringify(library.chunkingConfig),
      JSON.stringify(library.embeddingConfig),
      JSON.stringify(library.retrievalConfig),
      0,
      0,
      0,
      now,
      now
    );

    logger.info(`[DocumentStore] Created library: ${library.name}`);
    return library;
  }

  /**
   * Get all knowledge bases
   */
  getAllLibraries(): KnowledgeBase[] {
    // Update statistics for all libraries first
    this.refreshAllLibraryStats();

    const stmt = this.db.prepare('SELECT * FROM libraries ORDER BY created_at DESC');
    const rows = stmt.all() as LibraryRow[];
    return rows.map((row) => this.mapRowToLibrary(row));
  }

  /**
   * Refresh statistics for all knowledge bases
   */
  refreshAllLibraryStats(): void {
    const libraries = this.db.prepare('SELECT id FROM libraries').all() as LibraryIdRow[];
    for (const lib of libraries) {
      this.updateLibraryStats(lib.id);
    }
  }

  /**
   * Get knowledge base
   */
  getLibrary(id: string): KnowledgeBase | null {
    const stmt = this.db.prepare('SELECT * FROM libraries WHERE id = ?');
    const row = stmt.get(id) as LibraryRow | undefined;
    return row ? this.mapRowToLibrary(row) : null;
  }

  /**
   * Update knowledge base
   */
  updateLibrary(id: string, updates: Partial<KnowledgeBase>): boolean {
    const existing = this.getLibrary(id);
    if (!existing) return false;

    const updated = { ...existing, ...updates, updatedAt: Date.now() };

    const stmt = this.db.prepare(`
      UPDATE libraries SET
        name = ?,
        description = ?,
        chunking_config = ?,
        embedding_config = ?,
        retrieval_config = ?,
        document_count = ?,
        chunk_count = ?,
        total_size = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.name,
      updated.description || null,
      JSON.stringify(updated.chunkingConfig),
      JSON.stringify(updated.embeddingConfig),
      JSON.stringify(updated.retrievalConfig),
      updated.documentCount,
      updated.chunkCount,
      updated.totalSize,
      updated.updatedAt,
      id
    );

    return true;
  }

  /**
   * Async batch delete knowledge base
   * Avoids blocking main thread with large transactions
   *
   * Note: SQLite doesn't support DELETE ... LIMIT by default, so use subquery + rowid for batch deletion
   * @param id Knowledge base ID
   * @param onProgress Progress callback (progress: 0-100, message: status description)
   */
  async deleteLibraryAsync(
    id: string,
    onProgress?: (progress: number, message: string) => void
  ): Promise<boolean> {
    logger.info(`[DocumentStore] Starting async deletion of knowledge base: ${id}`);
    // Reduce batch size to minimize blocking time per SQL execution
    const batchSize = 200;

    // Count total first to calculate progress
    const ftsCount =
      (
        this.db
          .prepare('SELECT COUNT(*) as count FROM chunks_fts WHERE library_id = ?')
          .get(id) as { count: number }
      )?.count || 0;

    const embeddingCount =
      (
        this.db
          .prepare('SELECT COUNT(*) as count FROM embeddings WHERE library_id = ?')
          .get(id) as { count: number }
      )?.count || 0;

    const chunkCount =
      (
        this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE library_id = ?').get(id) as {
          count: number;
        }
      )?.count || 0;

    const docCount =
      (
        this.db.prepare('SELECT COUNT(*) as count FROM documents WHERE library_id = ?').get(id) as {
          count: number;
        }
      )?.count || 0;

    // Total work = FTS + embeddings + chunks + documents + library (library counts as 1)
    const totalWork = ftsCount + embeddingCount + chunkCount + docCount + 1;
    let completedWork = 0;

    const reportProgress = (message: string) => {
      if (onProgress) {
        const progress = totalWork > 0 ? Math.round((completedWork / totalWork) * 100) : 0;
        onProgress(Math.min(progress, 99), message); // Max 99%, send 100% when complete
      }
    };

    // 1. Delete FTS records (most time-consuming, batch delete)
    // FTS5 table uses rowid as primary key
    try {
      reportProgress(`Cleaning search index (0/${ftsCount})`);
      let deletedFts = 0;
      while (true) {
        // Get list of rowids to delete first
        const rowids = this.db
          .prepare('SELECT rowid FROM chunks_fts WHERE library_id = ? LIMIT ?')
          .all(id, batchSize) as { rowid: number }[];

        if (rowids.length === 0) break;

        // Batch delete using IN clause
        const placeholders = rowids.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM chunks_fts WHERE rowid IN (${placeholders})`)
          .run(...rowids.map((r) => r.rowid));

        deletedFts += rowids.length;
        completedWork += rowids.length;
        reportProgress(`Cleaning search index (${deletedFts}/${ftsCount})`);

        logger.info(`[DocumentStore] FTS deletion batch: ${rowids.length} records`);
        // Yield CPU - 16ms ≈ one frame time, gives UI update opportunity
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      logger.info('[DocumentStore] ✓ FTS records deleted');
    } catch (e) {
      console.error('[DocumentStore] FTS deletion failed:', e);
      completedWork += ftsCount; // Advance progress even on failure
    }

    // 2. Delete embedding records (batch)
    try {
      reportProgress(`Cleaning vector embeddings (0/${embeddingCount})`);
      let deletedEmb = 0;
      while (true) {
        // Get list of chunk_ids to delete
        const ids = this.db
          .prepare('SELECT chunk_id FROM embeddings WHERE library_id = ? LIMIT ?')
          .all(id, batchSize) as { chunk_id: string }[];

        if (ids.length === 0) break;

        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`)
          .run(...ids.map((r) => r.chunk_id));

        deletedEmb += ids.length;
        completedWork += ids.length;
        reportProgress(`Cleaning vector embeddings (${deletedEmb}/${embeddingCount})`);

        logger.info(`[DocumentStore] embeddings deletion batch: ${ids.length} records`);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      logger.info('[DocumentStore] ✓ Embedding records deleted');
    } catch (e) {
      console.error('[DocumentStore] Embedding deletion failed:', e);
      completedWork += embeddingCount;
    }

    // 3. Delete chunks (batch)
    try {
      reportProgress(`Cleaning document chunks (0/${chunkCount})`);
      let deletedChunks = 0;
      while (true) {
        // Get list of ids to delete
        const ids = this.db
          .prepare('SELECT id FROM chunks WHERE library_id = ? LIMIT ?')
          .all(id, batchSize) as { id: string }[];

        if (ids.length === 0) break;

        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`)
          .run(...ids.map((r) => r.id));

        deletedChunks += ids.length;
        completedWork += ids.length;
        reportProgress(`Cleaning document chunks (${deletedChunks}/${chunkCount})`);

        logger.info(`[DocumentStore] chunks deletion batch: ${ids.length} records`);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      logger.info('[DocumentStore] ✓ Chunks deleted');
    } catch (e) {
      console.error('[DocumentStore] Chunk deletion failed:', e);
      completedWork += chunkCount;
    }

    // 4. Delete documents (usually small count, delete all at once)
    try {
      reportProgress(`Cleaning document records (${docCount})`);
      this.db.prepare('DELETE FROM documents WHERE library_id = ?').run(id);
      completedWork += docCount;
      logger.info('[DocumentStore] ✓ Documents deleted');
    } catch (e) {
      console.error('[DocumentStore] Document deletion failed:', e);
      completedWork += docCount;
    }

    // 5. Finally delete library entry
    try {
      reportProgress('Cleaning complete');
      const stmt = this.db.prepare('DELETE FROM libraries WHERE id = ?');
      const result = stmt.run(id);
      completedWork += 1;
      logger.info('[DocumentStore] ✓ Library deletion complete');

      // Send 100% completion
      if (onProgress) {
        onProgress(100, 'Deletion complete');
      }

      return result.changes > 0;
    } catch (e) {
      console.error('[DocumentStore] Failed to delete library entry:', e);
      return false;
    }
  }

  /**
   * Delete knowledge base (synchronous version, kept for backward compatibility)
   */
  deleteLibrary(id: string): boolean {
    // ... existing implementation ...
    logger.info(`[DocumentStore] Deleting knowledge base: ${id}`);

    // Delete FTS records first (FTS table has no foreign key constraints, must delete manually)
    try {
      this.db.prepare('DELETE FROM chunks_fts WHERE library_id = ?').run(id);
      logger.info('[DocumentStore] ✓ FTS records deleted');
    } catch (e) {
      console.error('[DocumentStore] FTS deletion failed:', e);
    }

    // Delete embedding records
    try {
      this.db.prepare('DELETE FROM embeddings WHERE library_id = ?').run(id);
      logger.info('[DocumentStore] ✓ Embedding records deleted');
    } catch (e) {
      console.error('[DocumentStore] Embedding deletion failed:', e);
    }

    // Delete chunks (will cascade via foreign key, but explicitly delete for safety)
    try {
      this.db.prepare('DELETE FROM chunks WHERE library_id = ?').run(id);
      logger.info('[DocumentStore] ✓ Chunks deleted');
    } catch (e) {
      console.error('[DocumentStore] Chunk deletion failed:', e);
    }

    // Delete documents
    try {
      this.db.prepare('DELETE FROM documents WHERE library_id = ?').run(id);
      logger.info('[DocumentStore] ✓ Documents deleted');
    } catch (e) {
      console.error('[DocumentStore] Document deletion failed:', e);
    }

    // Finally delete library
    const stmt = this.db.prepare('DELETE FROM libraries WHERE id = ?');
    const result = stmt.run(id);
    logger.info('[DocumentStore] ✓ Library deletion complete');
    return result.changes > 0;
  }

  /**
   * Update knowledge base statistics
   */
  updateLibraryStats(libraryId: string): void {
    // Query document count, chunk count, and total size separately to avoid JOIN counting issues
    const docStats = this.db
      .prepare(`
      SELECT COUNT(*) as doc_count, COALESCE(SUM(file_size), 0) as total_size
      FROM documents WHERE library_id = ?
    `)
      .get(libraryId) as DocStatsRow | undefined;

    const chunkStats = this.db
      .prepare(`
      SELECT COUNT(*) as chunk_count
      FROM chunks WHERE document_id IN (
        SELECT id FROM documents WHERE library_id = ?
      )
    `)
      .get(libraryId) as ChunkStatsRow | undefined;

    const docCount = docStats?.doc_count || 0;
    const chunkCount = chunkStats?.chunk_count || 0;
    const totalSize = docStats?.total_size || 0;

    logger.info(
      `[DocumentStore] Updating stats for library ${libraryId}: docs=${docCount}, chunks=${chunkCount}, size=${totalSize}`
    );

    this.db
      .prepare(`
      UPDATE libraries SET
        document_count = ?,
        chunk_count = ?,
        total_size = ?,
        updated_at = ?
      WHERE id = ?
    `)
      .run(docCount, chunkCount, totalSize, Date.now(), libraryId);
  }

  // ==================== Document Operations ====================

  /**
   * Create document
   */
  createDocument(params: {
    libraryId: string;
    filename: string;
    filePath: string;
    fileSize: number;
    mediaType: MediaType;
    mimeType: string;
    bibKey?: string;
    citationText?: string;
    metadata?: DocumentMetadata;
  }): Document {
    const id = this.generateId('doc');
    const now = Date.now();
    const fileHash = this.computeHash(params.filePath + now);

    const document: Document = {
      id,
      libraryId: params.libraryId,
      filename: params.filename,
      filePath: params.filePath,
      fileSize: params.fileSize,
      fileHash,
      mediaType: params.mediaType,
      mimeType: params.mimeType,
      bibKey: params.bibKey,
      citationText: params.citationText,
      processStatus: 'pending',
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO documents (
        id, library_id, filename, file_path, file_size, file_hash,
        media_type, mime_type, bib_key, citation_text,
        process_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      document.id,
      document.libraryId,
      document.filename,
      document.filePath,
      document.fileSize,
      document.fileHash,
      document.mediaType,
      document.mimeType,
      document.bibKey || null,
      document.citationText || null,
      document.processStatus,
      JSON.stringify(document.metadata),
      now,
      now
    );

    // Update library statistics (document count)
    this.updateLibraryStats(params.libraryId);

    logger.info(`[DocumentStore] Created document: ${document.filename}`);
    return document;
  }

  /**
   * Get document
   */
  getDocument(id: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    const row = stmt.get(id) as DocumentRow | undefined;
    return row ? this.mapRowToDocument(row) : null;
  }

  /**
   * Get document by filename
   * Used for finding clipping aggregation files (e.g., Clippings-2026-01.md)
   */
  getDocumentByFilename(libraryId: string, filename: string): Document | null {
    const stmt = this.db.prepare(`
      SELECT * FROM documents 
      WHERE library_id = ? AND filename = ?
      LIMIT 1
    `);
    const row = stmt.get(libraryId, filename) as DocumentRow | undefined;
    return row ? this.mapRowToDocument(row) : null;
  }

  /**
   * Get all documents in a library
   */
  getDocumentsByLibrary(libraryId: string): Document[] {
    const stmt = this.db.prepare(`
      SELECT * FROM documents 
      WHERE library_id = ? 
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(libraryId) as DocumentRow[];
    return rows.map((row) => this.mapRowToDocument(row));
  }

  /**
   * Get all documents in a library (async version)
   *
   * P0 fix: Force main process read to ensure strong consistency
   * Previous Worker read caused write-then-read inconsistency (Worker read stale data)
   * Since getting document list is lightweight (only queries metadata), safe to execute in main process
   */
  async getDocumentsByLibraryAsync(libraryId: string): Promise<Document[]> {
    logger.info(
      `[DocumentStore] Synchronously getting documents to ensure consistency: libraryId=${libraryId}`
    );
    return Promise.resolve(this.getDocumentsByLibrary(libraryId));
  }

  /**
   * Update document status
   */
  updateDocumentStatus(id: string, status: ProcessStatus, errorMessage?: string): void {
    const stmt = this.db.prepare(`
      UPDATE documents SET
        process_status = ?,
        processed_at = ?,
        error_message = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      status,
      status === 'completed' || status === 'failed' ? Date.now() : null,
      errorMessage || null,
      Date.now(),
      id
    );
  }

  /**
   * Update document metadata
   */
  updateDocumentMetadata(id: string, metadata: Partial<DocumentMetadata>): void {
    const doc = this.getDocument(id);
    if (!doc) return;

    const updatedMetadata = { ...doc.metadata, ...metadata };

    this.db
      .prepare(`
      UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?
    `)
      .run(JSON.stringify(updatedMetadata), Date.now(), id);
  }

  deleteDocument(id: string): boolean {
    const doc = this.getDocument(id);
    if (!doc) return false;

    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes > 0) {
      this.updateLibraryStats(doc.libraryId);
    }

    return result.changes > 0;
  }

  getPendingDocuments(limit = 10): Document[] {
    const stmt = this.db.prepare(`
      SELECT * FROM documents 
      WHERE process_status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as DocumentRow[];
    return rows.map((row) => this.mapRowToDocument(row));
  }

  // ==================== Chunk Operations ====================

  createChunks(documentId: string, libraryId: string, chunks: ChunkData[]): Chunk[] {
    const now = Date.now();
    const createdChunks: Chunk[] = [];

    const insertStmt = this.db.prepare(`
      INSERT INTO chunks (
        id, document_id, library_id, content, content_hash,
        chunk_index, chunk_type, start_offset, end_offset,
        prev_chunk_id, next_chunk_id, parent_chunk_id,
        chunk_metadata, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((chunks: ChunkData[]) => {
      let prevChunkId: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const chunkData = chunks[i];
        const id = this.generateId('chunk');
        const contentHash = this.computeHash(chunkData.content);

        const chunk: Chunk = {
          id,
          documentId,
          libraryId,
          content: chunkData.content,
          contentHash,
          embedding: chunkData.embedding,
          chunkIndex: i,
          chunkType: chunkData.chunkType,
          startOffset:
            typeof chunkData.metadata.startOffset === 'number'
              ? chunkData.metadata.startOffset
              : undefined,
          endOffset:
            typeof chunkData.metadata.endOffset === 'number'
              ? chunkData.metadata.endOffset
              : undefined,
          prevChunkId,
          chunkMetadata: chunkData.metadata,
          isEnabled: true,
          createdAt: now,
          updatedAt: now,
        };

        insertStmt.run(
          chunk.id,
          chunk.documentId,
          chunk.libraryId,
          chunk.content,
          chunk.contentHash,
          chunk.chunkIndex,
          chunk.chunkType,
          chunk.startOffset || null,
          chunk.endOffset || null,
          chunk.prevChunkId || null,
          null, // nextChunkId - updated later
          null, // parentChunkId
          JSON.stringify(chunk.chunkMetadata),
          1,
          now,
          now
        );

        // Update previous chunk's nextChunkId to maintain linked list structure
        if (prevChunkId) {
          this.db
            .prepare(`
            UPDATE chunks SET next_chunk_id = ? WHERE id = ?
          `)
            .run(id, prevChunkId);
        }

        // Insert into FTS index synchronously to ensure searchability
        this.db
          .prepare(`
          INSERT INTO chunks_fts (content, chunk_id, library_id)
          VALUES (?, ?, ?)
        `)
          .run(chunk.content, chunk.id, chunk.libraryId);

        prevChunkId = id;
        createdChunks.push(chunk);
      }
    });

    insertMany(chunks);

    logger.info(
      `[DocumentStore] Created ${createdChunks.length} chunks for document ${documentId}`
    );
    logger.info('[DocumentStore] FTS index synchronized');
    return createdChunks;
  }

  /**
   * Async version using Worker thread to avoid blocking the main thread.
   * Falls back to synchronous version if Worker is unavailable.
   */
  async createChunksAsync(
    documentId: string,
    libraryId: string,
    chunks: ChunkData[],
    onProgress?: (progress: number, message: string) => void
  ): Promise<Chunk[]> {
    const workerClient = await this.getWorkerClient();

    // Fall back to synchronous version if Worker is unavailable
    if (!workerClient || !workerClient.getIsInitialized()) {
      logger.info('[DocumentStore] Worker unavailable, using sync mode to create chunks');
      return this.createChunks(documentId, libraryId, chunks);
    }

    logger.info(`[DocumentStore] Using Worker to async create ${chunks.length} chunks`);

    try {
      // Convert ChunkData to Worker-compatible format
      const workerChunks: ChunkDataInput[] = chunks.map((c) => ({
        content: c.content,
        chunkType: c.chunkType,
        metadata: c.metadata as Record<string, unknown>,
        embedding: c.embedding,
      }));

      const createdChunkInfos = await workerClient.createChunks(
        documentId,
        libraryId,
        workerChunks,
        onProgress
      );

      // Convert Worker's simplified data back to full Chunk objects
      const now = Date.now();
      const createdChunks: Chunk[] = createdChunkInfos.map((info, i) => ({
        id: info.id,
        documentId: info.documentId,
        libraryId: info.libraryId,
        content: info.content,
        contentHash: info.contentHash,
        embedding: chunks[i]?.embedding,
        chunkIndex: info.chunkIndex,
        chunkType: info.chunkType as ChunkType,
        startOffset:
          typeof chunks[i]?.metadata.startOffset === 'number'
            ? chunks[i]?.metadata.startOffset
            : undefined,
        endOffset:
          typeof chunks[i]?.metadata.endOffset === 'number'
            ? chunks[i]?.metadata.endOffset
            : undefined,
        prevChunkId: i > 0 ? createdChunkInfos[i - 1].id : undefined,
        nextChunkId: i < createdChunkInfos.length - 1 ? createdChunkInfos[i + 1].id : undefined,
        chunkMetadata: chunks[i]?.metadata || {},
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      }));

      logger.info(
        `[DocumentStore] ✓ Worker async creation complete: ${createdChunks.length} chunks`
      );
      return createdChunks;
    } catch (error) {
      console.error(
        '[DocumentStore] Worker chunk creation failed, falling back to sync mode:',
        error
      );
      return this.createChunks(documentId, libraryId, chunks);
    }
  }

  getChunksByDocument(documentId: string): Chunk[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks 
      WHERE document_id = ? 
      ORDER BY chunk_index ASC
    `);
    const rows = stmt.all(documentId) as ChunkRow[];
    return rows.map((row) => this.mapRowToChunk(row));
  }

  /**
   * Async version using Worker thread. Falls back to synchronous method if Worker unavailable.
   */
  async getChunksByDocumentAsync(documentId: string): Promise<Chunk[]> {
    const workerClient = await this.getWorkerClient();

    if (!workerClient || !workerClient.getIsInitialized()) {
      logger.info('[DocumentStore] Worker unavailable, using sync mode to get chunks');
      return this.getChunksByDocument(documentId);
    }

    try {
      logger.info(`[DocumentStore] Using Worker to async get chunks: documentId=${documentId}`);
      const chunkDataList = await workerClient.getChunks(documentId);

      // Convert Worker's data format to Chunk type
      const chunks: Chunk[] = chunkDataList.map((data) => ({
        id: data.id,
        documentId: data.documentId,
        libraryId: data.libraryId,
        content: data.content,
        contentHash: data.contentHash,
        chunkIndex: data.chunkIndex,
        chunkType: data.chunkType as ChunkType,
        startOffset: data.startOffset || undefined,
        endOffset: data.endOffset || undefined,
        prevChunkId: data.prevChunkId || undefined,
        nextChunkId: data.nextChunkId || undefined,
        parentChunkId: data.parentChunkId || undefined,
        chunkMetadata: data.chunkMetadata,
        isEnabled: data.isEnabled,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      }));

      logger.info(`[DocumentStore] ✓ Worker async retrieval complete: ${chunks.length} chunks`);
      return chunks;
    } catch (error) {
      console.error(
        '[DocumentStore] Worker chunk retrieval failed, falling back to sync mode:',
        error
      );
      return this.getChunksByDocument(documentId);
    }
  }

  getChunk(id: string): Chunk | null {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
    const row = stmt.get(id) as ChunkRow | undefined;
    return row ? this.mapRowToChunk(row) : null;
  }

  setChunkEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(`
      UPDATE chunks SET is_enabled = ?, updated_at = ? WHERE id = ?
    `)
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  deleteChunksByDocument(documentId: string): number {
    // Get chunk IDs first to delete related FTS records
    const chunkIds = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ?')
      .all(documentId) as Array<{ id: string }>;

    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`)
        .run(...chunkIds.map((c) => c.id));
    }

    const result = this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
    logger.info(`[DocumentStore] Deleted ${result.changes} chunks and their FTS indices`);
    return result.changes;
  }

  getChunksWithoutEmbedding(libraryId: string, limit = 100): Chunk[] {
    const stmt = this.db.prepare(`
      SELECT c.* FROM chunks c
      LEFT JOIN embeddings e ON c.id = e.chunk_id
      WHERE c.library_id = ? AND e.id IS NULL AND c.is_enabled = 1
      LIMIT ?
    `);
    const rows = stmt.all(libraryId, limit) as ChunkRow[];
    return rows.map((row) => this.mapRowToChunk(row));
  }

  // ==================== Utility Methods ====================

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private mapRowToLibrary(row: LibraryRow): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      chunkingConfig: JSON.parse(row.chunking_config),
      embeddingConfig: JSON.parse(row.embedding_config),
      retrievalConfig: JSON.parse(row.retrieval_config),
      documentCount: row.document_count,
      chunkCount: row.chunk_count,
      totalSize: row.total_size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRowToDocument(row: DocumentRow): Document {
    return {
      id: row.id,
      libraryId: row.library_id,
      filename: row.filename,
      filePath: row.file_path ?? '',
      fileSize: row.file_size,
      fileHash: row.file_hash ?? '',
      mediaType: row.media_type as MediaType,
      mimeType: row.mime_type ?? '',
      bibKey: row.bib_key ?? undefined,
      citationText: row.citation_text ?? undefined,
      processStatus: row.process_status as ProcessStatus,
      processedAt: row.processed_at ?? undefined,
      errorMessage: row.error_message ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRowToChunk(row: ChunkRow): Chunk {
    return {
      id: row.id,
      documentId: row.document_id,
      libraryId: row.library_id,
      content: row.content,
      contentHash: row.content_hash,
      chunkIndex: row.chunk_index,
      chunkType: row.chunk_type as Chunk['chunkType'],
      startOffset: row.start_offset ?? undefined,
      endOffset: row.end_offset ?? undefined,
      prevChunkId: row.prev_chunk_id ?? undefined,
      nextChunkId: row.next_chunk_id ?? undefined,
      parentChunkId: row.parent_chunk_id ?? undefined,
      chunkMetadata: row.chunk_metadata ? JSON.parse(row.chunk_metadata) : {},
      isEnabled: row.is_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
