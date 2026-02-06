/**
 * @file IPC Types - IPC Communication Type Definitions
 * @description Defines data structures for communication between main and renderer processes
 */

import type {
  LaTeXEngine,
  OverleafCompiler as OverleafCompilerType,
} from '../../renderer/src/types/app';

// ====== LaTeX Compilation ======

/** LaTeX compilation options */
export interface CompileLatexOptions {
  /** Compilation engine */
  engine?: LaTeXEngine;
  /** Enable shell-escape */
  shellEscape?: boolean;
  /** Enable SyncTeX */
  synctex?: boolean;
  /** Output directory */
  outputDirectory?: string;
  /** Stop on first error */
  stopOnFirstError?: boolean;
  /** Draft mode */
  draft?: boolean;
  /** Main file path (for SyncTeX) */
  mainFile?: string;
}

// ====== Overleaf ======

/** Overleaf compilation options */
export interface OverleafCompileOptions {
  /** Compiler */
  compiler?: OverleafCompilerType;
  /** Draft mode */
  draft?: boolean;
  /** Syntax check */
  check?: 'silent' | 'error' | 'validate';
  /** Enable SyncTeX */
  syncType?: 'full' | 'none';
}

/** Overleaf project settings */
export interface OverleafProjectSettings {
  /** Compiler */
  compiler?: OverleafCompilerType;
  /** Root document path */
  rootDocPath?: string;
  /** Spell check language */
  spellCheckLanguage?: string;
}

// ====== Knowledge Base ======

/** Knowledge base chunking configuration */
export interface ChunkingConfig {
  /** Chunk size */
  chunkSize?: number;
  /** Chunk overlap */
  chunkOverlap?: number;
  /** Chunking strategy */
  strategy?: 'fixed' | 'semantic' | 'paragraph';
  /** Separators */
  separators?: string[];
  /** Multimodal support */
  enableMultimodal?: boolean;
}

/** Knowledge base embedding configuration */
export interface EmbeddingConfig {
  /** Embedding model */
  model?: string;
  /** Embedding dimensions */
  dimensions?: number;
}

/** Knowledge base retrieval configuration */
export interface RetrievalConfig {
  /** Maximum results */
  maxResults?: number;
  /** Score threshold */
  scoreThreshold?: number;
  /** Use hybrid search */
  useHybridSearch?: boolean;
  /** BM25 weight */
  bm25Weight?: number;
  /** Vector weight */
  vectorWeight?: number;
}

/** Knowledge base update parameters */
export interface LibraryUpdateParams {
  /** Name */
  name?: string;
  /** Description */
  description?: string;
  /** Chunking configuration */
  chunkingConfig?: ChunkingConfig;
  /** Embedding configuration */
  embeddingConfig?: EmbeddingConfig;
  /** Retrieval configuration */
  retrievalConfig?: RetrievalConfig;
}

/** Document metadata */
export interface DocumentMetadata {
  /** Title */
  title?: string;
  /** Abstract */
  abstract?: string;
  /** Authors */
  authors?: string[];
  /** Keywords */
  keywords?: string[];
  /** Custom fields */
  [key: string]: unknown;
}

/** Add document options */
export interface AddDocumentOptions {
  /** BibTeX key */
  bibKey?: string;
  /** Citation text */
  citationText?: string;
  /** Metadata */
  metadata?: DocumentMetadata;
  /** Process immediately */
  processImmediately?: boolean;
}

/** Add text content options */
export interface AddTextOptions {
  /** Title */
  title?: string;
  /** Media type */
  mediaType?: 'pdf' | 'audio' | 'image' | 'markdown' | 'text' | 'latex' | 'url';
  /** BibTeX key */
  bibKey?: string;
  /** Metadata */
  metadata?: DocumentMetadata;
}

/** Knowledge base creation parameters */
export interface CreateLibraryParams {
  /** Name */
  name: string;
  /** Description */
  description?: string;
  /** Chunking configuration */
  chunkingConfig?: ChunkingConfig;
  /** Embedding configuration */
  embeddingConfig?: EmbeddingConfig;
  /** Retrieval configuration */
  retrievalConfig?: RetrievalConfig;
}
