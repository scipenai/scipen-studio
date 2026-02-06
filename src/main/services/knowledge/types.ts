/**
 * @file Knowledge Types - Knowledge Base Type Definitions
 * @description Defines core types for knowledge base, documents, chunks, embeddings, retrieval with multimodal support (PDF/audio/image/text)
 */

// ====== Basic Enums ======

/** Media type */
export type MediaType = 'pdf' | 'audio' | 'image' | 'markdown' | 'text' | 'latex' | 'url';

/** Document processing status */
export type ProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** Chunk type */
export type ChunkType =
  | 'text'
  | 'image_ocr'
  | 'image_caption'
  | 'audio_transcript'
  | 'summary'
  | 'entity';

/** Retriever type */
export type RetrieverType = 'vector' | 'keyword' | 'hybrid';

/** Embedding model provider */
export type EmbeddingProvider = 'openai' | 'ollama' | 'local';

// ====== Knowledge Base Models ======

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;

  chunkingConfig: ChunkingConfig;
  embeddingConfig: EmbeddingConfig;
  retrievalConfig: RetrievalConfig;

  documentCount: number;
  chunkCount: number;
  totalSize: number; // bytes

  createdAt: number;
  updatedAt: number;
}

export interface ChunkingConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  enableMultimodal: boolean;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string; // e.g., "text-embedding-3-small"
  dimensions: number; // e.g., 1536
  baseUrl?: string;
  apiKey?: string;
}

export interface RetrievalConfig {
  retrieverType: RetrieverType;
  vectorWeight: number;
  keywordWeight: number;
  topK: number;
  scoreThreshold: number;
  enableRerank: boolean;
}

export interface AdvancedRetrievalConfig {
  enableQueryRewrite: boolean;
  enableRerank: boolean;
  enableContextRouting: boolean;
  enableBilingualSearch: boolean;
}

// ====== Document Models ======

/** Document (original file) */
export interface Document {
  id: string;
  libraryId: string;

  // File information
  filename: string;
  filePath: string; // Object storage path
  fileSize: number;
  fileHash: string; // MD5 hash
  mediaType: MediaType;
  mimeType: string;

  // Citation information (core for academic scenarios)
  bibKey?: string; // BibTeX Key
  citationText?: string; // Full citation text (APA/IEEE)

  // Processing status
  processStatus: ProcessStatus;
  processedAt?: number;
  errorMessage?: string;

  // Metadata
  metadata: DocumentMetadata;

  // Timestamps
  createdAt: number;
  updatedAt: number;
}

/** Document metadata */
export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  year?: number;
  journal?: string;
  doi?: string;

  // Audio-specific
  duration?: number; // seconds
  language?: string;

  // Image-specific
  width?: number;
  height?: number;
  format?: string;

  // Extended fields - use unknown to ensure type safety
  [key: string]: string | string[] | number | undefined;
}

// ====== Chunk Models ======

/** Knowledge chunk (minimum retrieval unit) */
export interface Chunk {
  id: string;
  documentId: string;
  libraryId: string;

  content: string;
  contentHash: string;

  // Use Float32Array for performance and memory optimization
  embedding?: Float32Array | number[];
  embeddingModel?: string;

  chunkIndex: number;
  chunkType: ChunkType;
  startOffset?: number;
  endOffset?: number;

  // Linked list structure for context continuity
  prevChunkId?: string;
  nextChunkId?: string;
  parentChunkId?: string;

  chunkMetadata: ChunkMetadata;

  isEnabled: boolean;

  createdAt: number;
  updatedAt: number;
}

/** Chunk metadata (multimodal-specific storage) */
export interface ChunkMetadata {
  // PDF-specific
  page?: number;
  section?: string;

  // Audio-specific
  startTime?: number; // seconds
  endTime?: number; // seconds
  speaker?: string;

  // Image-specific
  imagePath?: string;
  imageUrl?: string;
  ocrText?: string;
  caption?: string;

  // Extended fields - use unknown for type safety
  [key: string]: string | number | boolean | undefined;
}

// ====== Retrieval Models ======

export interface SearchParams {
  query: string;
  libraryIds?: string[];
  mediaTypes?: MediaType[];
  topK?: number;
  scoreThreshold?: number;
  retrieverType?: RetrieverType;
  includeContent?: boolean;
  includeSources?: boolean;

  excludeDocumentIds?: string[];
  excludeChunkIds?: string[];

  // Use unknown for type safety
  metadataFilter?: Record<string, unknown>;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  libraryId: string;

  content: string;
  score: number;

  mediaType: MediaType;
  filename: string;
  bibKey?: string;
  citationText?: string;

  chunkMetadata: ChunkMetadata;

  highlights?: string[];
}

export interface RAGResponse {
  answer: string;
  sources: SearchResult[];
  citations: Citation[];
  context: string;
}

export interface Citation {
  id: string;
  bibKey: string;
  text: string;
  source: string;
  page?: number;
  timestamp?: number; // Audio timestamp
}

// ====== Task Queue Models ======

export type TaskType =
  | 'process_document'
  | 'generate_embedding'
  | 'process_audio'
  | 'process_image'
  | 'reindex_library';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProcessTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number; // 0-10, higher is more prioritized

  payload: TaskPayload;

  progress: number; // 0-100
  message?: string;

  // Use unknown for type safety, caller must type assert
  result?: unknown;
  error?: string;

  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  retryCount: number;
  maxRetries: number;
}

export interface TaskPayload {
  documentId?: string;
  libraryId?: string;
  filePath?: string;
  filename?: string;
  mediaType?: MediaType;
  chunkIds?: string[];
  options?: Record<string, unknown>;
}

// ====== Processor Result Models ======

export interface ProcessorResult {
  success: boolean;
  chunks: ChunkData[];
  metadata?: DocumentMetadata;
  error?: string;
}

export interface ChunkData {
  content: string;
  chunkType: ChunkType;
  metadata: ChunkMetadata;
  // Use Float32Array for performance optimization
  embedding?: Float32Array | number[];
}

// ====== Performance Optimization Utilities ======

/**
 * Convert number[] to Float32Array (zero-copy optimization)
 * Returns input directly if already Float32Array
 */
export function toFloat32Array(arr: Float32Array | number[] | undefined): Float32Array | undefined {
  if (!arr) return undefined;
  if (arr instanceof Float32Array) return arr;
  return new Float32Array(arr);
}

/**
 * Convert Float32Array to number[] (compatibility)
 * Returns input directly if already number[]
 */
export function toNumberArray(arr: Float32Array | number[] | undefined): number[] | undefined {
  if (!arr) return undefined;
  if (Array.isArray(arr)) return arr;
  return Array.from(arr);
}

/**
 * Convert Float32Array to Buffer (for database storage)
 */
export function float32ToBuffer(arr: Float32Array | number[]): Buffer {
  const float32 = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Convert Buffer to Float32Array (from database read)
 */
export function bufferToFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / Float32Array.BYTES_PER_ELEMENT
  );
}

// ====== Audio Processing Specific ======

export interface TranscriptSegment {
  text: string;
  start: number; // seconds
  end: number; // seconds
  speaker?: string;
  confidence?: number;
}

export interface AudioProcessOptions {
  language?: string; // Language code, e.g., "zh", "en"
  enableSpeakerDiarization?: boolean;
  enableTimestamps?: boolean;
  model?: string; // Whisper model
}

// ====== Image Processing Specific ======

/** Image processing options */
export interface ImageProcessOptions {
  enableOCR?: boolean;
  enableCaptioning?: boolean;
  vlmModel?: string; // VLM model, e.g., "gpt-4o"
  captionPrompt?: string;
}

/** Image processing result */
export interface ImageProcessResult {
  ocrText?: string;
  caption?: string;
  imageUrl?: string;
  dimensions?: { width: number; height: number };
}

// ====== PDF Processing Specific ======

/** PDF processing options */
export interface PDFProcessOptions {
  extractImages?: boolean;
  extractTables?: boolean;
  enableOCR?: boolean;
  pageRange?: [number, number];
}

/** PDF page content */
export interface PDFPageContent {
  pageNumber: number;
  text: string;
  images?: { path: string; caption?: string }[];
  tables?: string[][];
}

// ====== Event Models ======

/** Event type */
export type EventType =
  | 'document:added'
  | 'document:processed'
  | 'document:failed'
  | 'document:deleted'
  | 'library:created'
  | 'library:updated'
  | 'library:deleted'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'search:completed';

/** Event data */
export interface KnowledgeEvent {
  type: EventType;
  timestamp: number;
  data: KnowledgeEventData;
}

/** Knowledge base event data union type */
export type KnowledgeEventData =
  | { documentId: string; libraryId?: string; filename?: string }
  | { libraryId: string; name?: string }
  | { taskId: string; progress?: number; message?: string }
  | { query: string; resultCount?: number }
  | Record<string, unknown>;

/** Event listener */
export type EventListener = (event: KnowledgeEvent) => void;

// ====== Service Configuration ======

/** Knowledge base service configuration */
export interface KnowledgeServiceConfig {
  // Storage path
  storagePath: string;

  // Default configuration
  defaultChunkingConfig: ChunkingConfig;
  defaultEmbeddingConfig: EmbeddingConfig;
  defaultRetrievalConfig: RetrievalConfig;

  // Processor configuration
  audioProcessOptions: AudioProcessOptions;
  imageProcessOptions: ImageProcessOptions;
  pdfProcessOptions: PDFProcessOptions;

  // Concurrency control
  maxConcurrentTasks: number;

  // Cache configuration
  enableCache: boolean;
  cacheSize: number; // MB
}

// ====== Default Configuration ======

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 512,
  chunkOverlap: 50,
  // Separator priority: paragraph > line break > period > other punctuation
  // Supports both Chinese and English punctuation
  separators: [
    '\n\n', // Paragraph separator
    '\n', // Line break
    '。', // Chinese period
    '.', // English period
    '！',
    '!', // Chinese and English exclamation marks
    '？',
    '?', // Chinese and English question marks
    '；',
    ';', // Chinese and English semicolons
    '，',
    ',', // Chinese and English commas (split by comma last)
  ],
  enableMultimodal: true,
};

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  retrieverType: 'hybrid',
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  topK: 5,
  scoreThreshold: 0.1, // Lower default threshold to avoid over-filtering
  enableRerank: false,
};
