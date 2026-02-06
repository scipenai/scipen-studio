/**
 * @file MultimodalKnowledgeService - Multimodal Knowledge Base Core Service
 * @description Integrates storage, processing, and retrieval, providing unified API for knowledge base management
 * @depends VectorStore, DocumentStore, HybridRetriever, TaskQueue, processors
 */

// Note: Removed synchronous node:fs imports; all file operations now use async fs-extra
import { EventEmitter } from 'events';
import * as path from 'path';
import { app } from 'electron';
import fs from './utils/fsCompat';

import { DocumentStore } from './storage/DocumentStore';
// Storage
import { VectorStore, type VectorStoreConfig } from './storage/VectorStore';

import { AudioProcessor } from './processors/AudioProcessor';
import type { BaseProcessor, ProcessorContext } from './processors/BaseProcessor';
import { ImageProcessor } from './processors/ImageProcessor';
import { PDFProcessor } from './processors/PDFProcessor';
// Processors
import { TextProcessor } from './processors/TextProcessor';

// Retrieval
import {
  type AdvancedRetrievalConfig,
  DEFAULT_ADVANCED_CONFIG,
  HybridRetriever,
  type RetrieveOptions,
} from './retrieval/HybridRetriever';

// Embedding
import { EmbeddingService } from './embedding/EmbeddingService';

// Queue
import { TaskQueue } from './queue/TaskQueue';

// Worker
import {
  type DiagnosticsData,
  type SQLiteWorkerClient,
  getSQLiteWorkerClient,
} from '../../workers/SQLiteWorkerClient';
import { createLogger } from '../LoggerService';

import type { ClipData, DiagnosticsInfo } from '../interfaces/IKnowledgeService';
// Types
import {
  type Chunk,
  type ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  type Document,
  type DocumentMetadata,
  type EmbeddingConfig,
  type EventType,
  type KnowledgeBase,
  type KnowledgeEvent,
  type KnowledgeEventData,
  type MediaType,
  type ProcessTask,
  type RAGResponse,
  type RetrievalConfig,
  type SearchResult,
} from './types';

/** Service initialization options */
export interface InitOptions {
  storagePath?: string;
  // Embedding 配置
  embeddingProvider?: 'openai' | 'ollama' | 'local';
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  // LLM 对话模型配置 (用于摘要生成、查询重写等)
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  // VLM 配置 (视觉语言模型 - 图片理解)
  vlmProvider?: 'openai' | 'anthropic' | 'ollama' | 'custom';
  vlmApiKey?: string;
  vlmBaseUrl?: string;
  vlmModel?: string;
  // Whisper 配置 (语音转录)
  whisperApiKey?: string;
  whisperBaseUrl?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  // Legacy config compatibility
  visionApiKey?: string;
  visionBaseUrl?: string;
  // Advanced retrieval configuration
  advancedRetrieval?: Partial<AdvancedRetrievalConfig>;
}

export class MultimodalKnowledgeService extends EventEmitter {
  private logger = createLogger('MultimodalKnowledgeService');
  private vectorStore!: VectorStore;
  private documentStore!: DocumentStore;
  private embeddingService!: EmbeddingService;
  private retriever!: HybridRetriever;
  private taskQueue!: TaskQueue;

  // Processors
  private textProcessor!: TextProcessor;
  private pdfProcessor!: PDFProcessor;
  private audioProcessor!: AudioProcessor;
  private imageProcessor!: ImageProcessor;

  private storagePath: string;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private advancedRetrievalConfig: AdvancedRetrievalConfig = { ...DEFAULT_ADVANCED_CONFIG };

  // SQLite Worker - for time-consuming database operations
  private sqliteWorker: SQLiteWorkerClient | null = null;

  // Clip write queue - prevents data loss when concurrently appending to the same monthly file
  private clipWriteQueue = new Map<string, Promise<unknown>>();

  // LLM configuration (for summary generation, query rewriting, etc.)
  private llmConfig: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  } = {};

  // Pending delete persistence manager - tracks knowledge bases that failed to delete, retries on next startup
  private get pendingDeleteFile(): string {
    return path.join(this.storagePath, 'pending_delete.json');
  }

  /**
   * Pending delete file manager
   *
   * Persistently tracks knowledge bases that failed to delete, retries deletion on next startup.
   *
   * P0 performance optimization: All operations are async to avoid blocking Electron main thread.
   * Uses mutex lock to prevent race conditions from concurrent read/write.
   */
  private pendingDeleteManager = {
    /** Mutex lock ensuring atomic file operations */
    _lock: Promise.resolve(),

    /**
     * Mutex lock wrapper
     * Ensures only one operation executes at a time, preventing race conditions
     */
    _withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      let release: () => void;
      const nextLock = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Wait for previous lock to release, then set new lock
      const prevLock = this.pendingDeleteManager._lock;
      this.pendingDeleteManager._lock = nextLock;

      try {
        await prevLock;
        return await fn();
      } finally {
        release!();
      }
    },

    /**
     * Load pending delete IDs asynchronously
     * Uses fs-extra async API to avoid blocking the main thread
     */
    load: async (): Promise<string[]> => {
      return this.pendingDeleteManager._withLock(async () => {
        try {
          if (await fs.pathExists(this.pendingDeleteFile)) {
            const content = await fs.readFile(this.pendingDeleteFile, 'utf-8');
            const data = JSON.parse(content);
            return Array.isArray(data) ? data : [];
          }
        } catch (error) {
          console.warn('[MultimodalKnowledgeService] Failed to load pending delete IDs:', error);
        }
        return [];
      });
    },

    /**
     * Save pending delete IDs asynchronously
     * Uses atomic write (write to temp file then rename) to prevent file corruption on write interruption
     */
    save: async (ids: string[]): Promise<void> => {
      return this.pendingDeleteManager._withLock(async () => {
        try {
          await fs.ensureDir(path.dirname(this.pendingDeleteFile));

          // Atomic write: write to temp file first, then rename to prevent corruption
          const tempFile = `${this.pendingDeleteFile}.tmp`;
          await fs.writeFile(tempFile, JSON.stringify(ids, null, 2), 'utf-8');
          await fs.move(tempFile, this.pendingDeleteFile, { overwrite: true });

          this.logger.debug(`[MultimodalKnowledgeService] Saved ${ids.length} pending delete IDs`);
        } catch (error) {
          console.warn('[MultimodalKnowledgeService] Failed to save pending delete IDs:', error);
        }
      });
    },

    /**
     * Add library to pending delete list asynchronously
     */
    add: async (id: string): Promise<void> => {
      // Perform read-modify-write inside lock to ensure atomicity
      return this.pendingDeleteManager._withLock(async () => {
        try {
          let existingIds: string[] = [];
          if (await fs.pathExists(this.pendingDeleteFile)) {
            const content = await fs.readFile(this.pendingDeleteFile, 'utf-8');
            existingIds = JSON.parse(content) || [];
          }

          if (!existingIds.includes(id)) {
            existingIds.push(id);

            await fs.ensureDir(path.dirname(this.pendingDeleteFile));
            const tempFile = `${this.pendingDeleteFile}.tmp`;
            await fs.writeFile(tempFile, JSON.stringify(existingIds, null, 2), 'utf-8');
            await fs.move(tempFile, this.pendingDeleteFile, { overwrite: true });
          }
        } catch (error) {
          console.warn('[MultimodalKnowledgeService] Failed to add to pending delete list:', error);
        }
      });
    },

    /**
     * Remove library from pending delete list asynchronously
     */
    remove: async (id: string): Promise<void> => {
      // Perform read-modify-write inside lock to ensure atomicity
      return this.pendingDeleteManager._withLock(async () => {
        try {
          if (!(await fs.pathExists(this.pendingDeleteFile))) {
            return;
          }

          const content = await fs.readFile(this.pendingDeleteFile, 'utf-8');
          const existingIds: string[] = JSON.parse(content) || [];
          const filteredIds = existingIds.filter((existingId) => existingId !== id);

          if (filteredIds.length !== existingIds.length) {
            const tempFile = `${this.pendingDeleteFile}.tmp`;
            await fs.writeFile(tempFile, JSON.stringify(filteredIds, null, 2), 'utf-8');
            await fs.move(tempFile, this.pendingDeleteFile, { overwrite: true });
          }
        } catch (error) {
          console.warn(
            '[MultimodalKnowledgeService] Failed to remove from pending delete list:',
            error
          );
        }
      });
    },

    /**
     * Clear pending delete list asynchronously
     */
    clear: async (): Promise<void> => {
      return this.pendingDeleteManager._withLock(async () => {
        try {
          if (await fs.pathExists(this.pendingDeleteFile)) {
            await fs.remove(this.pendingDeleteFile);
          }
        } catch (error) {
          console.warn('[MultimodalKnowledgeService] Failed to clear pending delete file:', error);
        }
      });
    },
  };

  constructor() {
    super();
    this.storagePath = path.join(app.getPath('userData'), 'MultimodalKnowledge');
  }

  /**
   * Clean up knowledge bases that failed to delete in previous session
   * Called during initialization
   */
  private async cleanupPendingDeletes(): Promise<void> {
    const pendingDeleteIds = await this.pendingDeleteManager.load();

    if (pendingDeleteIds.length === 0) {
      return;
    }

    this.logger.info(
      `[MultimodalKnowledgeService] Found ${pendingDeleteIds.length} knowledge bases pending deletion from previous session`
    );

    let deletedCount = 0;
    const failedIds: string[] = [];

    for (const id of pendingDeleteIds) {
      try {
        this.logger.info(`[MultimodalKnowledgeService] Retrying delete for knowledge base: ${id}`);

        if (this.documentStore) {
          const success = this.documentStore.deleteLibrary(id);
          if (success) {
            deletedCount++;
            this.logger.info(
              `[MultimodalKnowledgeService] Successfully deleted pending knowledge base: ${id}`
            );
          } else {
            failedIds.push(id);
            console.warn(
              `[MultimodalKnowledgeService] Failed to delete pending knowledge base: ${id}`
            );
          }
        } else {
          failedIds.push(id);
        }
      } catch (error) {
        failedIds.push(id);
        console.warn(
          `[MultimodalKnowledgeService] Error deleting pending knowledge base ${id}:`,
          error
        );
      }
    }

    if (failedIds.length > 0) {
      await this.pendingDeleteManager.save(failedIds);
      console.warn(
        `[MultimodalKnowledgeService] ${failedIds.length} knowledge bases still pending deletion`
      );
    } else {
      await this.pendingDeleteManager.clear();
    }

    this.logger.info(
      `[MultimodalKnowledgeService] Startup cleanup completed: ${deletedCount}/${pendingDeleteIds.length} knowledge bases deleted`
    );
  }

  /**
   * Initialize service
   *
   * Uses initPromise to prevent duplicate initialization and race conditions
   */
  async initialize(options: InitOptions = {}): Promise<boolean> {
    // Return existing promise if initialization is already in progress or completed
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize(options);
    return this.initPromise;
  }

  /**
   * Execute actual initialization logic (internal method)
   */
  private async doInitialize(options: InitOptions): Promise<boolean> {
    try {
      this.storagePath = options.storagePath || this.storagePath;
      await fs.ensureDir(this.storagePath);

      const vectorStoreConfig: VectorStoreConfig = {
        dbPath: path.join(this.storagePath, 'knowledge.db'),
        dimensions: 1536, // OpenAI text-embedding-3-small default dimensions
      };
      this.vectorStore = new VectorStore(vectorStoreConfig);

      this.documentStore = new DocumentStore(this.vectorStore.getDbPath());

      this.embeddingService = new EmbeddingService({
        provider: 'openai',
        model: options.embeddingModel || 'text-embedding-3-small',
        dimensions: 1536,
        apiKey: options.embeddingApiKey,
        baseUrl: options.embeddingBaseUrl,
      });

      if (options.advancedRetrieval) {
        this.advancedRetrievalConfig = {
          ...this.advancedRetrievalConfig,
          ...options.advancedRetrieval,
        };
      }

      this.retriever = new HybridRetriever(
        this.vectorStore,
        this.embeddingService,
        undefined,
        this.advancedRetrievalConfig
      );

      if (options.embeddingApiKey) {
        this.retriever.initializeAdvancedFeatures(
          options.embeddingApiKey,
          options.embeddingBaseUrl
        );
      }

      this.textProcessor = new TextProcessor();
      this.pdfProcessor = new PDFProcessor();

      this.audioProcessor = new AudioProcessor({
        apiKey: options.whisperApiKey || options.embeddingApiKey || '',
        baseUrl: options.whisperBaseUrl || options.embeddingBaseUrl,
      });

      this.imageProcessor = new ImageProcessor({
        apiKey: options.visionApiKey || options.embeddingApiKey || '',
        baseUrl: options.visionBaseUrl || options.embeddingBaseUrl,
      });

      this.taskQueue = new TaskQueue(2);
      this.setupTaskHandlers();

      // Initialize SQLite Worker for time-consuming database operations
      try {
        this.sqliteWorker = getSQLiteWorkerClient();
        await this.sqliteWorker.initialize(path.join(this.storagePath, 'knowledge.db'));
        this.logger.info('[MultimodalKnowledgeService] ✓ SQLite Worker initialized successfully');
      } catch (workerError) {
        console.warn(
          '[MultimodalKnowledgeService] SQLite Worker initialization failed, falling back to main thread:',
          workerError
        );
        this.sqliteWorker = null;
      }

      this.initialized = true;
      this.logger.info('[MultimodalKnowledgeService] Initialized successfully');

      await this.cleanupPendingDeletes();

      return true;
    } catch (error) {
      console.error('[MultimodalKnowledgeService] Initialization failed:', error);
      // Clear initPromise to allow retry
      this.initPromise = null;
      return false;
    }
  }

  /**
   * Update API configuration
   * Implements IKnowledgeService.updateConfig
   */
  async updateConfig(options: Partial<InitOptions>): Promise<void> {
    this.logger.info('[MultimodalKnowledgeService] updateConfig called');
    this.logger.info(
      '[MultimodalKnowledgeService] Received parameters:',
      JSON.stringify({
        embeddingProvider: options.embeddingProvider,
        embeddingApiKey: options.embeddingApiKey ? 'set' : 'not set',
        embeddingBaseUrl: options.embeddingBaseUrl,
        embeddingModel: options.embeddingModel,
        vlmApiKey: options.vlmApiKey ? 'set' : 'not set',
        vlmModel: options.vlmModel,
        whisperApiKey: options.whisperApiKey ? 'set' : 'not set',
        whisperModel: options.whisperModel,
      })
    );

    const embeddingConfig: Record<string, unknown> = {};
    if (options.embeddingProvider !== undefined) {
      embeddingConfig.provider = options.embeddingProvider;
    }
    if (options.embeddingApiKey !== undefined) {
      embeddingConfig.apiKey = options.embeddingApiKey;
    }
    if (options.embeddingBaseUrl !== undefined) {
      embeddingConfig.baseUrl = options.embeddingBaseUrl;
    }
    if (options.embeddingModel !== undefined) {
      embeddingConfig.model = options.embeddingModel;
    }

    if (Object.keys(embeddingConfig).length > 0) {
      this.logger.info(
        '[MultimodalKnowledgeService] Updating EmbeddingService configuration...',
        Object.keys(embeddingConfig)
      );
      this.embeddingService.updateConfig(embeddingConfig);
      this.logger.info('[MultimodalKnowledgeService] ✓ EmbeddingService configuration updated');

      // Initialize advanced retrieval features if API key is provided
      if (options.embeddingApiKey && this.retriever) {
        this.logger.info(
          '[MultimodalKnowledgeService] Initializing advanced retrieval features...'
        );
        this.retriever.initializeAdvancedFeatures(
          options.embeddingApiKey,
          options.embeddingBaseUrl
        );
        this.logger.info('[MultimodalKnowledgeService] ✓ Advanced retrieval features initialized');
      }
    } else {
      this.logger.info(
        '[MultimodalKnowledgeService] ⚠ Skipping Embedding update (no valid config items)'
      );
    }

    const whisperConfig: Record<string, unknown> = {};
    if (options.whisperApiKey !== undefined) {
      whisperConfig.apiKey = options.whisperApiKey;
    }
    if (options.whisperBaseUrl !== undefined) {
      whisperConfig.baseUrl = options.whisperBaseUrl;
    }
    if (options.whisperModel !== undefined) {
      whisperConfig.model = options.whisperModel;
    }
    if (options.whisperLanguage !== undefined) {
      whisperConfig.language = options.whisperLanguage;
    }

    if (Object.keys(whisperConfig).length > 0 && this.audioProcessor) {
      this.logger.info(
        '[MultimodalKnowledgeService] Updating AudioProcessor (Whisper) configuration...'
      );
      this.audioProcessor.updateConfig(whisperConfig);
      this.logger.info('[MultimodalKnowledgeService] ✓ AudioProcessor configuration updated');
    }

    const vlmConfig: Record<string, unknown> = {};
    // Prefer new vlm config, fallback to legacy vision config for compatibility
    if (options.vlmApiKey !== undefined) {
      vlmConfig.apiKey = options.vlmApiKey;
    } else if (options.visionApiKey !== undefined) {
      vlmConfig.apiKey = options.visionApiKey;
    }
    if (options.vlmBaseUrl !== undefined) {
      vlmConfig.baseUrl = options.vlmBaseUrl;
    } else if (options.visionBaseUrl !== undefined) {
      vlmConfig.baseUrl = options.visionBaseUrl;
    }
    if (options.vlmModel !== undefined) {
      vlmConfig.model = options.vlmModel;
    }

    if (Object.keys(vlmConfig).length > 0 && this.imageProcessor) {
      this.logger.info(
        '[MultimodalKnowledgeService] Updating ImageProcessor (VLM) configuration...'
      );
      this.imageProcessor.updateConfig(vlmConfig);
      this.logger.info('[MultimodalKnowledgeService] ✓ ImageProcessor configuration updated');
    }

    // Prefer dedicated llm config, fallback to embedding config
    if (
      options.llmApiKey !== undefined ||
      options.llmBaseUrl !== undefined ||
      options.llmModel !== undefined
    ) {
      if (options.llmApiKey !== undefined) this.llmConfig.apiKey = options.llmApiKey;
      if (options.llmBaseUrl !== undefined) this.llmConfig.baseUrl = options.llmBaseUrl;
      if (options.llmModel !== undefined) this.llmConfig.model = options.llmModel;
      this.logger.info('[MultimodalKnowledgeService] ✓ LLM configuration updated:', {
        hasApiKey: !!this.llmConfig.apiKey,
        baseUrl: this.llmConfig.baseUrl,
        model: this.llmConfig.model,
      });
    }
    // Fallback to embedding config if no dedicated LLM config exists
    if (!this.llmConfig.apiKey && options.embeddingApiKey) {
      this.llmConfig.apiKey = options.embeddingApiKey;
      this.llmConfig.baseUrl = options.embeddingBaseUrl;
      // Don't set model, let summary generation method choose appropriate model automatically
      this.logger.info('[MultimodalKnowledgeService] LLM config falling back to Embedding config');
    }

    // Update advanced retrieval configuration
    if (options.advancedRetrieval && this.retriever) {
      this.advancedRetrievalConfig = {
        ...this.advancedRetrievalConfig,
        ...options.advancedRetrieval,
      };
      this.retriever.updateAdvancedConfig(this.advancedRetrievalConfig);
      this.logger.info('[MultimodalKnowledgeService] ✓ Advanced retrieval configuration updated');
    }

    // Sync LLM config to advanced retrieval components
    if (this.retriever && (this.llmConfig.apiKey || options.embeddingApiKey)) {
      const llmApiKey = this.llmConfig.apiKey || options.embeddingApiKey;
      const llmBaseUrl = this.llmConfig.baseUrl || options.embeddingBaseUrl;
      // May be undefined, let component use default value
      const llmModel = this.llmConfig.model;
      this.retriever.initializeAdvancedFeatures(llmApiKey!, llmBaseUrl, llmModel);
      this.logger.info('[MultimodalKnowledgeService] ✓ Advanced retrieval LLM config synchronized');
    }
  }

  /**
   * Setup task handlers
   */
  private setupTaskHandlers(): void {
    this.taskQueue.registerHandler('process_document', async (task) => {
      const { documentId, libraryId, filePath, mediaType } = task.payload;
      if (!documentId || !libraryId || !filePath || !mediaType) {
        throw new Error('Missing required payload fields');
      }

      this.taskQueue.updateProgress(task.id, 10, 'Starting document processing...');

      const processor = this.getProcessor(mediaType);
      if (!processor) {
        throw new Error(`No processor for media type: ${mediaType}`);
      }

      this.documentStore.updateDocumentStatus(documentId, 'processing');

      const library = this.documentStore.getLibrary(libraryId);
      const chunkingConfig = library?.chunkingConfig;

      const context: ProcessorContext = {
        documentId,
        libraryId,
        filePath,
        filename: path.basename(filePath),
        options: { chunkingConfig },
      };

      this.taskQueue.updateProgress(task.id, 30, 'Parsing document content...');
      const result = await processor.process(context);

      if (!result.success) {
        this.documentStore.updateDocumentStatus(documentId, 'failed', result.error);
        throw new Error(result.error);
      }

      // Create chunks asynchronously using Worker to avoid blocking main thread
      this.taskQueue.updateProgress(task.id, 50, 'Creating document chunks...');
      const chunks = await this.documentStore.createChunksAsync(
        documentId,
        libraryId,
        result.chunks,
        (progress, message) => {
          // Map chunk creation progress to 50-60% range
          const mappedProgress = 50 + Math.round(progress * 0.1);
          this.taskQueue.updateProgress(task.id, mappedProgress, message);
        }
      );

      this.taskQueue.updateProgress(task.id, 60, 'Generating vector embeddings...');
      await this.generateEmbeddings(chunks, libraryId);

      this.taskQueue.updateProgress(task.id, 85, 'Generating document summary...');
      const summary = await this.generateDocumentSummary(chunks, result.metadata);

      const updatedMetadata = {
        ...result.metadata,
        abstract: summary || result.metadata?.abstract,
      };
      this.documentStore.updateDocumentMetadata(documentId, updatedMetadata);

      this.taskQueue.updateProgress(task.id, 100, 'Processing completed');
      this.documentStore.updateDocumentStatus(documentId, 'completed');
      this.documentStore.updateLibraryStats(libraryId);

      this.emitEvent('document:processed', {
        documentId,
        libraryId,
        chunkCount: chunks.length,
        summary,
      });

      return { chunkCount: chunks.length };
    });

    this.taskQueue.registerHandler('generate_embedding', async (task) => {
      const { chunkIds, libraryId } = task.payload;
      if (!chunkIds || !libraryId) {
        throw new Error('Missing required payload fields');
      }

      const chunks = await this.vectorStore.getChunksByIds(chunkIds);
      await this.generateEmbeddings(chunks, libraryId);

      return { count: chunks.length };
    });

    this.taskQueue.on('event', (event: KnowledgeEvent) => {
      this.emit(event.type, event);
      // Forward as generic event so setupKnowledgeEventForwarding can capture it
      this.emit('event', event);
    });
  }

  /**
   * Intelligently select chunks for summary generation
   *
   * Strategy:
   * 1. Skip chunks that are too short (likely titles, page numbers, etc.)
   * 2. Prioritize chunks containing keywords like "abstract", "摘要", "introduction", "引言"
   * 3. If none found, select the most content-rich chunks
   */
  private selectChunksForSummary(chunks: Chunk[], maxChunks = 5): Chunk[] {
    // Filter out chunks that are too short
    const meaningfulChunks = chunks.filter((c) => c.content.length > 100);

    if (meaningfulChunks.length === 0) {
      return chunks.slice(0, maxChunks);
    }

    // Priority keywords
    const priorityKeywords = [
      /abstract/i,
      /摘\s*要/,
      /introduction/i,
      /引言/,
      /overview/i,
      /概述/,
      /summary/i,
      /总结/,
      /conclusion/i,
      /结论/,
    ];

    // Score chunks by priority
    const scoredChunks = meaningfulChunks.map((chunk, index) => {
      let score = 0;

      // Check for priority keywords
      for (const pattern of priorityKeywords) {
        if (pattern.test(chunk.content)) {
          score += 10;
          break;
        }
      }

      // Give extra points to first meaningful chunks (usually content after abstract/introduction)
      if (index < 3) {
        score += 3 - index;
      }

      // Content richness (moderate length scores higher)
      const contentLength = chunk.content.length;
      if (contentLength > 200 && contentLength < 2000) {
        score += 2;
      }

      // Exclude chunks that might be table of contents or references
      const excludePatterns = [
        /^(table of contents|contents|目录)/i,
        /^(references|参考文献|bibliography)/i,
        /^(appendix|附录)/i,
        /^\d+\.\s*$/, // Pure numeric page numbers
      ];
      for (const pattern of excludePatterns) {
        if (pattern.test(chunk.content.trim().slice(0, 50))) {
          score -= 20;
          break;
        }
      }

      return { chunk, score };
    });

    // Sort by score and take top N
    scoredChunks.sort((a, b) => b.score - a.score);

    return scoredChunks.slice(0, maxChunks).map((sc) => sc.chunk);
  }

  /**
   * Generate document summary using LLM
   */
  private async generateDocumentSummary(
    chunks: Chunk[],
    existingMetadata?: DocumentMetadata
  ): Promise<string | null> {
    // Return existing abstract if available
    if (existingMetadata?.abstract && existingMetadata.abstract.length > 50) {
      this.logger.info('[MultimodalKnowledgeService] Using existing abstract from document');
      return existingMetadata.abstract;
    }

    // Use intelligent selection strategy to get most relevant chunks
    const contextChunks = this.selectChunksForSummary(chunks, 5);
    const context = contextChunks.map((c) => c.content).join('\n\n');

    if (context.length < 100) {
      this.logger.info(
        '[MultimodalKnowledgeService] Content too short, skipping summary generation'
      );
      return null;
    }

    try {
      // Prefer LLM config, fallback to embedding service config
      const apiKey = this.llmConfig.apiKey || this.embeddingService.getApiKey();
      const baseUrl = this.llmConfig.baseUrl || this.embeddingService.getBaseUrl();
      // Use user-configured LLM model, not hardcoded default
      const model = this.llmConfig.model;

      if (!apiKey) {
        this.logger.info(
          '[MultimodalKnowledgeService] API Key not configured, skipping summary generation'
        );
        return null;
      }

      if (!model) {
        this.logger.info(
          '[MultimodalKnowledgeService] LLM model not configured, skipping summary generation'
        );
        return null;
      }

      this.logger.info(`[MultimodalKnowledgeService] Generating summary using model: ${model}`);
      this.logger.info(
        `[MultimodalKnowledgeService] Selected ${contextChunks.length} chunks as context`
      );

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'system',
              content: `You are a professional document summarization expert. Please generate an accurate and concise summary (100-200 words) based on the provided document content.

Requirements:
1. Summarize the document's topic, core viewpoints, and key information
2. For academic papers, describe the research purpose, methods, and main findings
3. For technical documents, describe the functionality, purpose, and features
4. Output only the summary content, do not add prefixes like "Summary:"
5. Do not fabricate or speculate on information not mentioned in the original text`,
            },
            {
              role: 'user',
              content: `Please generate a summary for the following document content:\n\n${context.slice(0, 4000)}`,
            },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(
          '[MultimodalKnowledgeService] Summary generation request failed:',
          response.status,
          errorText
        );
        return null;
      }

      interface LLMResponse {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      }
      const data = (await response.json()) as LLMResponse;
      const summary = data.choices?.[0]?.message?.content?.trim();

      if (summary) {
        this.logger.info('[MultimodalKnowledgeService] ✓ Document summary generated successfully');
        return summary;
      }

      return null;
    } catch (error) {
      console.warn('[MultimodalKnowledgeService] Summary generation failed:', error);
      return null;
    }
  }

  /**
   * Generate embeddings with retry mechanism
   *
   * @param chunks - Chunks to generate embeddings for
   * @param libraryId - Knowledge base ID
   * @param retryCount - Current retry count (internal use)
   */
  private async generateEmbeddings(
    chunks: Chunk[],
    libraryId: string,
    retryCount = 0
  ): Promise<void> {
    const maxRetries = 3;
    const batchSize = 10; // Alibaba Cloud DashScope maximum limit is 10

    this.logger.info(
      `[MultimodalKnowledgeService] Starting embedding generation, chunks: ${chunks.length}, retry count: ${retryCount}`
    );

    // Check embedding service configuration
    const config = this.embeddingService.getConfig();
    this.logger.info('[MultimodalKnowledgeService] Embedding service configuration:', {
      provider: config.provider,
      model: config.model,
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl,
    });

    if (!config.apiKey) {
      console.warn(
        '[MultimodalKnowledgeService] ⚠ API Key not configured, skipping embedding generation'
      );
      return;
    }

    // Process in batches, track failed batches for retry
    const failedChunks: Chunk[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batchChunks = chunks.slice(i, i + batchSize);
      const batchContents = batchChunks.map((c) => c.content);

      try {
        const embedResults = await this.embeddingService.embedBatch(batchContents, { batchSize });

        this.logger.info(
          `[MultimodalKnowledgeService] ✓ Batch ${Math.floor(i / batchSize) + 1} embedding generation succeeded, count: ${embedResults.length}`
        );

        const items = batchChunks.map((chunk, j) => ({
          chunkId: chunk.id,
          libraryId,
          embedding: embedResults[j].embedding,
          model: embedResults[j].model,
        }));

        await this.vectorStore.insertEmbeddingsBatchAsync(items);
      } catch (error) {
        console.error(
          `[MultimodalKnowledgeService] ✗ Batch ${Math.floor(i / batchSize) + 1} embedding generation failed:`,
          error
        );
        failedChunks.push(...batchChunks);

        // If API rate limited, wait before continuing
        if (
          error instanceof Error &&
          (error.message.includes('429') || error.message.includes('rate limit'))
        ) {
          const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
          this.logger.info(
            `[MultimodalKnowledgeService] API rate limited, waiting ${waitTime}ms before continuing...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    // Retry failed batches if under max retry limit
    if (failedChunks.length > 0 && retryCount < maxRetries) {
      this.logger.info(
        `[MultimodalKnowledgeService] ${failedChunks.length} chunks failed embedding, retrying (attempt ${retryCount + 1})...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      await this.generateEmbeddings(failedChunks, libraryId, retryCount + 1);
    } else if (failedChunks.length > 0) {
      console.error(
        `[MultimodalKnowledgeService] ✗ Final: ${failedChunks.length} chunks failed embedding generation`
      );
      console.error(
        '[MultimodalKnowledgeService] Please check embedding service configuration or use "Generate Missing Embeddings" feature later'
      );
    } else {
      this.logger.info(
        '[MultimodalKnowledgeService] ✓ All embeddings successfully stored to database'
      );
    }
  }

  /**
   * Get processor for corresponding media type
   */
  private getProcessor(mediaType: MediaType): BaseProcessor | null {
    switch (mediaType) {
      case 'pdf':
        return this.pdfProcessor;
      case 'audio':
        return this.audioProcessor;
      case 'image':
        return this.imageProcessor;
      case 'markdown':
      case 'text':
      case 'latex':
        return this.textProcessor;
      default:
        return this.textProcessor;
    }
  }

  /**
   * Detect file media type
   */
  private detectMediaType(filename: string): MediaType {
    const ext = path.extname(filename).toLowerCase();

    if (['.pdf'].includes(ext)) return 'pdf';
    if (['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac'].includes(ext)) return 'audio';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.md', '.markdown'].includes(ext)) return 'markdown';
    if (['.tex', '.latex'].includes(ext)) return 'latex';

    return 'text';
  }

  /**
   * Generate unique filename to prevent overwriting files with same name
   *
   * Strategy: If target path exists, add numeric suffix (1), (2), ...
   * Example: paper.pdf -> paper (1).pdf -> paper (2).pdf
   *
   * @param libraryId - Knowledge base ID
   * @param originalFilename - Original filename
   * @returns Unique filename
   */
  private async generateUniqueFilename(
    libraryId: string,
    originalFilename: string
  ): Promise<string> {
    const baseDir = path.join(this.storagePath, 'files', libraryId);
    const ext = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, ext);

    let filename = originalFilename;
    let counter = 1;
    const maxAttempts = 1000; // Prevent infinite loop

    while (counter <= maxAttempts) {
      const targetPath = path.join(baseDir, filename);
      if (!(await fs.pathExists(targetPath))) {
        return filename;
      }
      // File exists, add numeric suffix
      filename = `${baseName} (${counter})${ext}`;
      counter++;
    }

    // Edge case: exceeded max attempts, use timestamp
    const timestamp = Date.now();
    return `${baseName}-${timestamp}${ext}`;
  }

  // ==================== Public API ====================

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
    this.ensureInitialized();
    const library = this.documentStore.createLibrary(params);
    this.emitEvent('library:created', { libraryId: library.id });
    return library;
  }

  /**
   * Get all knowledge bases
   */
  getAllLibraries(): KnowledgeBase[] {
    this.ensureInitialized();
    return this.documentStore.getAllLibraries();
  }

  /**
   * Get all knowledge bases (async version using Worker thread)
   */
  async getAllLibrariesAsync(): Promise<KnowledgeBase[]> {
    await this.ensureInitializedAsync();

    if (this.sqliteWorker) {
      try {
        const libraries = await this.sqliteWorker.getAllLibraries();
        return libraries.map((lib) => ({
          id: lib.id,
          name: lib.name,
          description: lib.description,
          chunkingConfig: DEFAULT_CHUNKING_CONFIG,
          embeddingConfig: DEFAULT_EMBEDDING_CONFIG,
          retrievalConfig: DEFAULT_RETRIEVAL_CONFIG,
          documentCount: lib.documentCount,
          chunkCount: lib.chunkCount,
          totalSize: lib.totalSize,
          createdAt: lib.createdAt,
          updatedAt: lib.updatedAt,
        }));
      } catch (error) {
        console.warn(
          '[MultimodalKnowledgeService] Worker failed to get libraries, falling back to sync method:',
          error
        );
      }
    }

    return this.documentStore.getAllLibraries();
  }

  /**
   * Get knowledge base
   */
  getLibrary(id: string): KnowledgeBase | null {
    this.ensureInitialized();
    return this.documentStore.getLibrary(id);
  }

  /**
   * Update knowledge base
   */
  updateLibrary(id: string, updates: Partial<KnowledgeBase>): boolean {
    this.ensureInitialized();
    const result = this.documentStore.updateLibrary(id, updates);
    if (result) {
      this.emitEvent('library:updated', { libraryId: id });
    }
    return result;
  }

  /**
   * Delete knowledge base
   * Uses async non-blocking mode to avoid UI freezing
   * Returns task ID for frontend to track progress
   */
  async deleteLibrary(id: string): Promise<boolean> {
    await this.ensureInitializedAsync();

    this.logger.info(`[MultimodalKnowledgeService] Received delete library request: ${id}`);

    const library = this.documentStore.getLibrary(id);
    const libraryName = library?.name || 'Unknown library';

    const taskId = `delete-${id}`;

    // Add library to pending delete list to prevent data residue if crash occurs during deletion
    // Use await to ensure async write completes
    await this.pendingDeleteManager.add(id);

    this.emitEvent('task:progress', {
      taskId,
      progress: 0,
      status: 'processing',
      message: `Preparing to delete "${libraryName}"...`,
      filename: libraryName,
      taskType: 'delete',
    });

    // Return true immediately for optimistic UI update; actual deletion happens asynchronously in background
    this.executeBackgroundDelete(id, taskId, libraryName).catch((err) => {
      console.error(
        `[MultimodalKnowledgeService] Background deletion of library ${id} failed:`,
        err
      );
      // Emit failure event (already recorded in pending delete list, will retry on next startup)
      this.emitEvent('task:progress', {
        taskId,
        progress: 0,
        status: 'failed',
        message: `Deletion failed: ${err.message}`,
        filename: libraryName,
        taskType: 'delete',
      });
    });

    return true;
  }

  /**
   * Execute delete operation in background
   * Prefer Worker Thread to avoid blocking main thread
   */
  private async executeBackgroundDelete(
    id: string,
    taskId: string,
    libraryName: string
  ): Promise<void> {
    try {
      let success = false;

      // Prefer Worker Thread for deletion to avoid blocking main thread
      if (this.sqliteWorker?.getIsInitialized()) {
        this.logger.info(
          `[MultimodalKnowledgeService] Using Worker Thread to delete library: ${id}`
        );

        success = await this.sqliteWorker.deleteLibrary(id, (progress) => {
          this.emitEvent('task:progress', {
            taskId,
            progress: progress.progress,
            status: 'processing',
            message: progress.message,
            filename: libraryName,
            taskType: 'delete',
          });
        });
      } else {
        // Fallback to main thread async batch deletion
        this.logger.info(
          `[MultimodalKnowledgeService] Falling back to main thread for library deletion: ${id}`
        );

        success = await this.documentStore.deleteLibraryAsync(id, (progress, message) => {
          this.emitEvent('task:progress', {
            taskId,
            progress,
            status: 'processing',
            message,
            filename: libraryName,
            taskType: 'delete',
          });
        });
      }

      if (success) {
        this.logger.info(
          `[MultimodalKnowledgeService] Database records deleted successfully: ${id}`
        );

        // Try to clean up HNSW index data (if supported)
        if (this.vectorStore) {
          // VectorStore may not have dedicated deleteLibraryFromIndex yet
          // Since database is cleared, index will auto-sync on next restart
          // TODO: Implement LibraryId-filtered deletion in VectorWorker in the future
        }

        // Remove from pending delete list on success
        await this.pendingDeleteManager.remove(id);

        this.emitEvent('task:progress', {
          taskId,
          progress: 100,
          status: 'completed',
          message: 'Deletion completed',
          filename: libraryName,
          taskType: 'delete',
        });

        this.emitEvent('library:deleted', { libraryId: id });
      }
    } catch (error) {
      console.error('[MultimodalKnowledgeService] Error during library deletion:', error);
      // Deletion failed, already recorded in pending delete list, will retry on next startup
      throw error;
    }
  }

  /**
   * Add document to library
   */
  async addDocument(
    libraryId: string,
    filePath: string,
    options?: {
      bibKey?: string;
      citationText?: string;
      metadata?: DocumentMetadata;
      processImmediately?: boolean;
    }
  ): Promise<Document & { taskId?: string }> {
    await this.ensureInitializedAsync();

    const library = this.documentStore.getLibrary(libraryId);
    if (!library) {
      throw new Error(`Library not found: ${libraryId}`);
    }

    if (!(await fs.pathExists(filePath))) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = await fs.stat(filePath);
    const originalFilename = path.basename(filePath);
    const mediaType = this.detectMediaType(originalFilename);

    const filename = await this.generateUniqueFilename(libraryId, originalFilename);

    const storedPath = path.join(this.storagePath, 'files', libraryId, filename);
    await fs.ensureDir(path.dirname(storedPath));
    await fs.copy(filePath, storedPath);

    const mimeType = this.getMimeType(filename);

    const document = this.documentStore.createDocument({
      libraryId,
      filename,
      filePath: storedPath,
      fileSize: stats.size,
      mediaType,
      mimeType,
      bibKey: options?.bibKey,
      citationText: options?.citationText,
      metadata: options?.metadata,
    });

    this.emitEvent('document:added', { documentId: document.id, libraryId });

    let taskId: string | undefined;
    if (options?.processImmediately !== false) {
      const task = this.taskQueue.addTask(
        'process_document',
        {
          documentId: document.id,
          libraryId,
          filePath: storedPath,
          mediaType,
          filename,
        },
        5
      );
      taskId = task.id;
    }

    return {
      ...document,
      taskId,
    };
  }

  /**
   * Add text content without requiring a file
   */
  async addTextContent(
    libraryId: string,
    content: string,
    options?: {
      title?: string;
      mediaType?: MediaType;
      bibKey?: string;
      metadata?: DocumentMetadata;
    }
  ): Promise<Document & { taskId?: string }> {
    await this.ensureInitializedAsync();

    const title = options?.title || `Text-${Date.now()}`;
    // Sanitize filename by removing illegal characters (Windows: \/:*?"<>|)
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
    const filename = `${safeTitle}.txt`;

    const tempPath = path.join(this.storagePath, 'temp', filename);
    await fs.ensureDir(path.dirname(tempPath));
    await fs.writeFile(tempPath, content, 'utf-8');

    return this.addDocument(libraryId, tempPath, {
      bibKey: options?.bibKey,
      metadata: { ...options?.metadata, title },
    });
  }

  /**
   * Add text (IKnowledgeService interface method)
   * Wrapper around addTextContent that returns format defined by IKnowledgeService interface
   */
  async addText(
    libraryId: string,
    content: string,
    options?: {
      title?: string;
      mediaType?: string;
      bibKey?: string;
      metadata?: DocumentMetadata;
    }
  ): Promise<{ documentId: string; taskId?: string }> {
    const result = await this.addTextContent(libraryId, content, {
      title: options?.title,
      mediaType: options?.mediaType as MediaType,
      bibKey: options?.bibKey,
      metadata: options?.metadata,
    });
    return { documentId: result.id, taskId: result.taskId };
  }

  /**
   * Add clip snippet (stored aggregated by month)
   *
   * Automatically appends to monthly Clippings-YYYY-MM.md file to avoid fragmentation.
   * Uses write queue to prevent data loss during concurrent appends.
   */
  async addClip(
    libraryId: string,
    clip: ClipData
  ): Promise<{ documentId: string; taskId?: string }> {
    await this.ensureInitializedAsync();

    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const filename = `Clippings-${yearMonth}.md`;

    const clipContent = this.formatClipMarkdown(clip);

    // Serialize writes to prevent concurrent overwrites
    // Use robust queue pattern: reset queue on failure to ensure subsequent writes can recover
    const queueKey = `${libraryId}:${filename}`;
    const prevPromise = this.clipWriteQueue.get(queueKey) || Promise.resolve();

    // Create new Promise and update queue immediately (before await)
    let resolve: (value: { documentId: string; taskId?: string }) => void;
    let reject: (error: unknown) => void;
    const writePromise = new Promise<{ documentId: string; taskId?: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.clipWriteQueue.set(queueKey, writePromise);
    const releaseQueue = () => {
      if (this.clipWriteQueue.get(queueKey) === writePromise) {
        this.clipWriteQueue.delete(queueKey);
      }
    };

    // Wait for previous write to complete (ignore errors to continue trying)
    try {
      await prevPromise;
    } catch {
      // Previous write failure doesn't affect current write
      this.logger.warn(
        '[MultimodalKnowledgeService] Previous clip write failed, continuing with current write'
      );
    }

    try {
      const existingDoc = this.documentStore.getDocumentByFilename(libraryId, filename);
      const storedFilePath = path.join(this.storagePath, 'files', libraryId, filename);

      if (existingDoc) {
        this.logger.info(
          `[MultimodalKnowledgeService] Appending to existing Clippings file: ${filename}`
        );
        await fs.appendFile(storedFilePath, `\n\n${clipContent}`, 'utf-8');

        // Trigger reprocessing to update index
        const task = await this.reprocessDocument(existingDoc.id);
        const result = { documentId: existingDoc.id, taskId: task?.id };
        releaseQueue();
        resolve!(result);
        return result;
      } else {
        // New file mode: write to temp directory first, then addDocument copies to files directory
        // This avoids "copying self to self" issue
        this.logger.info(`[MultimodalKnowledgeService] Creating new Clippings file: ${filename}`);
        const header = `# Clippings - ${yearMonth}\n\n> This file is automatically generated by SciPen Studio.\n\n---\n\n`;
        const tempDir = path.join(this.storagePath, 'temp', 'clippings', yearMonth);
        const tempFilePath = path.join(tempDir, filename);
        await fs.ensureDir(tempDir);
        await fs.writeFile(tempFilePath, header + clipContent, 'utf-8');

        const doc = await this.addDocument(libraryId, tempFilePath, {
          metadata: {
            title: `Clippings - ${yearMonth}`,
            sourceType: 'clippings',
          },
        });

        try {
          await fs.remove(tempFilePath);
        } catch {
          // Cleanup failure doesn't affect main flow
        }

        const result = { documentId: doc.id, taskId: doc.taskId };
        releaseQueue();
        resolve!(result);
        return result;
      }
    } catch (error) {
      this.logger.error('[MultimodalKnowledgeService] addClip failed:', error);
      // Reset queue on failure to ensure subsequent writes can recover
      releaseQueue();
      reject!(error);
      throw error;
    }
  }

  /**
   * Format clip snippet as Markdown
   */
  private formatClipMarkdown(clip: ClipData): string {
    const time = new Date(clip.capturedAt).toLocaleString('en-US');
    const source = clip.sourceApp ? ` | Source: ${clip.sourceApp}` : '';
    const note = clip.note ? `\n\n**Note**: ${clip.note}` : '';
    const tags = clip.tags?.length ? `\n\n**Tags**: ${clip.tags.join(', ')}` : '';

    const quotedText = clip.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    return `## [${time}]${source}\n\n${quotedText}${note}${tags}\n\n---`;
  }

  /**
   * Get document by ID
   */
  getDocument(id: string): Document | null {
    this.ensureInitialized();
    return this.documentStore.getDocument(id);
  }

  /**
   * Get all documents in a library
   */
  getDocumentsByLibrary(libraryId: string): Document[] {
    this.ensureInitialized();
    return this.documentStore.getDocumentsByLibrary(libraryId);
  }

  /**
   * Get all documents in a library (async version using Worker thread)
   * Recommended for large libraries or during UI-intensive operations to avoid blocking
   */
  async getDocumentsByLibraryAsync(libraryId: string): Promise<Document[]> {
    await this.ensureInitializedAsync();
    return this.documentStore.getDocumentsByLibraryAsync(libraryId);
  }

  /**
   * Get all chunks for a document (async version using Worker thread)
   */
  async getChunksByDocumentAsync(documentId: string): Promise<Chunk[]> {
    await this.ensureInitializedAsync();
    return this.documentStore.getChunksByDocumentAsync(documentId);
  }

  /**
   * Delete document (fully async, doesn't block UI)
   * Worker thread handles database operations, returns file path then deletes file
   */
  async deleteDocument(id: string): Promise<boolean> {
    await this.ensureInitializedAsync();
    this.logger.info(`[MultimodalKnowledgeService] Starting document deletion: ${id}`);
    this.logger.info(
      `[MultimodalKnowledgeService] Worker status: ${this.sqliteWorker ? 'initialized' : 'not initialized'}`
    );

    // Use Worker thread to delete database record (doesn't block UI)
    if (this.sqliteWorker) {
      try {
        this.logger.info('[MultimodalKnowledgeService] Using Worker to delete document...');
        const result = await this.sqliteWorker.deleteDocument(id);
        this.logger.info('[MultimodalKnowledgeService] Worker deletion completed:', result);

        if (result.filePath && (await fs.pathExists(result.filePath))) {
          await fs.remove(result.filePath);
        }

        if (result.deleted) {
          this.emitEvent('document:deleted', { documentId: id });
        }
        return result.deleted;
      } catch (error) {
        console.warn(
          '[MultimodalKnowledgeService] Worker deletion failed, falling back to sync method:',
          error
        );
      }
    }

    // Fallback to synchronous method
    this.logger.info('[MultimodalKnowledgeService] Using synchronous method to delete document...');
    const doc = this.documentStore.getDocument(id);
    if (!doc) return false;

    if (await fs.pathExists(doc.filePath)) {
      await fs.remove(doc.filePath);
    }

    const result = this.documentStore.deleteDocument(id);
    if (result) {
      this.emitEvent('document:deleted', { documentId: id });
    }
    return result;
  }

  /**
   * Search knowledge base
   */
  async search(options: RetrieveOptions): Promise<SearchResult[]> {
    await this.ensureInitializedAsync();
    return this.retriever.retrieve(options);
  }

  /**
   * Enhanced search (returns more metadata)
   */
  async searchEnhanced(options: RetrieveOptions) {
    await this.ensureInitializedAsync();
    return this.retriever.retrieveEnhanced(options);
  }

  /**
   * Get advanced retrieval configuration
   */
  getAdvancedRetrievalConfig(): AdvancedRetrievalConfig {
    return { ...this.advancedRetrievalConfig };
  }

  /**
   * Update advanced retrieval configuration
   */
  setAdvancedRetrievalConfig(
    config: Partial<AdvancedRetrievalConfig> & {
      rerankApiKey?: string;
      rerankBaseUrl?: string;
      rerankModel?: string;
      rerankProvider?:
        | 'dashscope'
        | 'openai'
        | 'cohere'
        | 'jina'
        | 'local'
        | 'siliconflow'
        | 'aihubmix'
        | 'custom';
    }
  ): void {
    this.advancedRetrievalConfig = { ...this.advancedRetrievalConfig, ...config };
    if (this.retriever) {
      this.retriever.updateAdvancedConfig(this.advancedRetrievalConfig);

      // Update Reranker API config if provided
      if (
        config.rerankApiKey ||
        config.rerankBaseUrl ||
        config.rerankModel ||
        config.rerankProvider
      ) {
        this.retriever.updateAdvancedApiConfig({
          rerankApiKey: config.rerankApiKey,
          rerankBaseUrl: config.rerankBaseUrl,
          rerankModel: config.rerankModel,
          rerankProvider: config.rerankProvider,
          // Also pass LLM config for QueryRewriter and ContextRouter
          llmApiKey: this.llmConfig.apiKey,
          llmBaseUrl: this.llmConfig.baseUrl,
          llmModel: this.llmConfig.model,
        });
        this.logger.info('[MultimodalKnowledgeService] ✓ Reranker API configuration updated');
      }
    }
  }

  /**
   * RAG query
   */
  async query(
    question: string,
    libraryIds?: string[],
    options?: {
      topK?: number;
      includeContext?: boolean;
    }
  ): Promise<RAGResponse> {
    await this.ensureInitializedAsync();

    const searchResults = await this.search({
      query: question,
      libraryIds,
      topK: options?.topK || 5,
    });

    const context = this.retriever.formatAsContext(searchResults);
    const citations = this.retriever.extractCitations(searchResults);

    return {
      answer: '', // Generated by caller using LLM
      sources: searchResults,
      citations: citations.map((c, i) => ({
        id: `cite-${i + 1}`,
        bibKey: c.bibKey,
        text: c.text,
        source: c.source,
      })),
      context,
    };
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId: string): ProcessTask | undefined {
    return this.taskQueue.getTask(taskId);
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): ReturnType<TaskQueue['getStats']> {
    return this.taskQueue.getStats();
  }

  /**
   * Test embedding service connection
   */
  async testEmbeddingConnection(): Promise<{ success: boolean; message: string }> {
    await this.ensureInitializedAsync();
    return this.embeddingService.testConnection();
  }

  /**
   * Get diagnostics (uses Worker thread, doesn't block UI)
   */
  async getDiagnostics(libraryId?: string): Promise<DiagnosticsInfo> {
    await this.ensureInitializedAsync();

    let data: DiagnosticsData;

    if (this.sqliteWorker) {
      try {
        data = await this.sqliteWorker.getDiagnostics(libraryId);
      } catch (error) {
        console.warn(
          '[MultimodalKnowledgeService] Worker failed to get diagnostics, falling back to sync method:',
          error
        );
        data = await this.vectorStore.getDiagnostics(libraryId);
      }
    } else {
      data = await this.vectorStore.getDiagnostics(libraryId);
    }

    return {
      initialized: true,
      libraryCount: data.libraryStats.length,
      // Cannot directly get total document count, requires additional query
      documentCount: 0,
      chunkCount: data.totalChunks,
      embeddingCount: data.totalEmbeddings,
      ftsRecords: data.ftsRecords,
      embeddingDimensions: data.embeddingDimensions,
      libraryStats: data.libraryStats,
    };
  }

  /**
   * Rebuild FTS index
   *
   * Uses async batch processing to avoid blocking UI
   */
  async rebuildFTSIndex(): Promise<{ success: boolean; recordCount: number }> {
    await this.ensureInitializedAsync();
    try {
      // Use async rebuild method
      const result = await this.vectorStore.rebuildFTSIndexAsync();
      return { success: result.success, recordCount: result.count };
    } catch (error) {
      console.error('[MultimodalKnowledgeService] FTS index rebuild failed:', error);
      return { success: false, recordCount: 0 };
    }
  }

  /**
   * Reprocess document (uses Worker thread to delete chunks, doesn't block UI)
   */
  async reprocessDocument(documentId: string): Promise<ProcessTask | null> {
    await this.ensureInitializedAsync();
    const doc = this.documentStore.getDocument(documentId);
    if (!doc) return null;

    // Use Worker thread to delete existing chunks (doesn't block UI)
    if (this.sqliteWorker) {
      try {
        await this.sqliteWorker.deleteChunksByDocument(documentId);
      } catch (error) {
        console.warn(
          '[MultimodalKnowledgeService] Worker failed to delete chunks, falling back to sync method:',
          error
        );
        this.documentStore.deleteChunksByDocument(documentId);
      }
    } else {
      this.documentStore.deleteChunksByDocument(documentId);
    }

    this.documentStore.updateDocumentStatus(documentId, 'pending');

    return this.taskQueue.addTask(
      'process_document',
      {
        documentId: doc.id,
        libraryId: doc.libraryId,
        filePath: doc.filePath,
        mediaType: doc.mediaType,
      },
      8
    );
  }

  /**
   * Generate missing embeddings for existing chunks
   * Used to fix documents that previously failed embedding generation
   *
   * @param libraryId - Optional, specify library ID, otherwise processes all libraries
   * @returns Generation result statistics
   */
  async generateMissingEmbeddings(
    libraryId?: string
  ): Promise<{ success: boolean; generated: number; errors: number; remaining: number }> {
    await this.ensureInitializedAsync();

    this.logger.info('[MultimodalKnowledgeService] Starting to generate missing embeddings...');

    let generated = 0;
    let errors = 0;
    let remaining = 0;
    const batchLimit = 500;

    try {
      const libraries = libraryId
        ? [this.documentStore.getLibrary(libraryId)].filter(Boolean)
        : this.documentStore.getAllLibraries();

      for (const library of libraries) {
        if (!library) continue;

        // Process in loop until no more missing embeddings
        let hasMore = true;
        while (hasMore) {
          const chunksWithoutEmbedding = this.documentStore.getChunksWithoutEmbedding(
            library.id,
            batchLimit
          );

          if (chunksWithoutEmbedding.length === 0) {
            this.logger.info(
              `[MultimodalKnowledgeService] Library ${library.name} has no more chunks missing embeddings`
            );
            hasMore = false;
            continue;
          }

          this.logger.info(
            `[MultimodalKnowledgeService] Library ${library.name} has ${chunksWithoutEmbedding.length} chunks needing embeddings`
          );

          // Use embedding generation with retry mechanism
          await this.generateEmbeddings(chunksWithoutEmbedding, library.id);

          // Check how many were actually generated
          const afterChunks = this.documentStore.getChunksWithoutEmbedding(library.id, 1);
          const actualGenerated = chunksWithoutEmbedding.length - afterChunks.length;
          generated += actualGenerated;
          errors += chunksWithoutEmbedding.length - actualGenerated;

          this.logger.info(
            `[MultimodalKnowledgeService] This batch: succeeded ${actualGenerated}, failed ${chunksWithoutEmbedding.length - actualGenerated}`
          );

          // Stop processing if entire batch failed (avoid infinite loop)
          if (actualGenerated === 0) {
            console.warn('[MultimodalKnowledgeService] Entire batch failed, stopping processing');
            remaining +=
              afterChunks.length > 0 ? afterChunks.length : chunksWithoutEmbedding.length;
            hasMore = false;
          }

          // No more chunks if retrieved count is less than batchLimit
          if (chunksWithoutEmbedding.length < batchLimit) {
            hasMore = false;
          }

          // Add small delay to avoid API rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      this.logger.info(
        `[MultimodalKnowledgeService] ✓ Embedding generation completed: succeeded ${generated}, failed ${errors}, remaining ${remaining}`
      );
      return { success: true, generated, errors, remaining };
    } catch (error) {
      console.error('[MultimodalKnowledgeService] ✗ Embedding generation failed:', error);
      return { success: false, generated, errors, remaining };
    }
  }

  /**
   * Close service
   */
  async close(): Promise<void> {
    // Close SQLite Worker
    if (this.sqliteWorker) {
      try {
        await this.sqliteWorker.terminate();
        this.sqliteWorker = null;
        this.logger.info('[MultimodalKnowledgeService] ✓ SQLite Worker closed');
      } catch (e) {
        console.error('[MultimodalKnowledgeService] Failed to close SQLite Worker:', e);
      }
    }

    // Close vector store
    if (this.vectorStore) {
      this.vectorStore.close();
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Ensure service is initialized (synchronous version)
   *
   * For synchronous methods, throws error if initialization not completed
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      if (this.initPromise) {
        throw new Error(
          'MultimodalKnowledgeService is still initializing. Please wait for initialize() to complete.'
        );
      }
      throw new Error('MultimodalKnowledgeService not initialized. Call initialize() first.');
    }
  }

  /**
   * Ensure service is initialized (async version)
   *
   * For async methods, waits for initialization to complete
   */
  private async ensureInitializedAsync(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      if (!this.initialized) {
        throw new Error('MultimodalKnowledgeService initialization failed.');
      }
      return;
    }

    throw new Error('MultimodalKnowledgeService not initialized. Call initialize() first.');
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.tex': 'text/x-tex',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.webm': 'audio/webm',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private emitEvent(type: EventType, data: KnowledgeEventData): void {
    const event: KnowledgeEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);
    this.emit('event', event);
  }
}

// Singleton instance
let serviceInstance: MultimodalKnowledgeService | null = null;

export function getKnowledgeService(): MultimodalKnowledgeService {
  if (!serviceInstance) {
    serviceInstance = new MultimodalKnowledgeService();
  }
  return serviceInstance;
}
