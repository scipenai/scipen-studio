/**
 * @file Mappers - Domain Model to DTO Conversion Utilities
 * @description Converts main process domain models to DTOs for IPC transport, handles date formatting and sensitive info filtering
 * @depends IKnowledgeService, IOverleafService, @shared/ipc/types
 */

// ====== Import Domain Models ======

import type {
  AdvancedRetrievalConfig,
  DiagnosticsInfo,
  Document,
  EnhancedSearchResult,
  KnowledgeBase,
  QueueStats,
  RAGResponse,
  SearchResult,
  TaskStatus,
} from '../services/interfaces/IKnowledgeService';

import type {
  OverleafCompileResult,
  OverleafProject,
} from '../services/interfaces/IOverleafService';

// ====== Import DTO Types ======

import type {
  AdvancedRetrievalConfigDTO,
  ChunkMetadataDTO,
  EnhancedSearchResultDTO,
  KnowledgeDiagnosticsDTO,
  KnowledgeDocumentDTO,
  KnowledgeLibraryDTO,
  KnowledgeQueueStatsDTO,
  KnowledgeRAGResponseDTO,
  KnowledgeSearchResultDTO,
  KnowledgeTaskStatusDTO,
  OverleafCompileResultDTO,
  OverleafProjectDTO,
} from '@shared/ipc/types';

// ====== Helper Functions ======

/**
 * Convert timestamp or Date object to ISO 8601 string
 * Supports Unix timestamp (number) and Date object
 */
function toISOString(date: Date | number | undefined | null): string {
  if (!date) {
    return new Date().toISOString();
  }
  if (typeof date === 'number') {
    return new Date(date).toISOString();
  }
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

// ====== Knowledge Mappers ======

/**
 * Convert KnowledgeBase (domain model) to KnowledgeLibraryDTO
 */
export function toKnowledgeLibraryDTO(model: KnowledgeBase): KnowledgeLibraryDTO {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    chunkingConfig: {
      chunkSize: model.chunkingConfig?.chunkSize ?? 1000,
      chunkOverlap: model.chunkingConfig?.chunkOverlap ?? 200,
      separators: ['\n\n', '\n', ' '],
      enableMultimodal: true,
    },
    embeddingConfig: {
      provider: 'openai',
      model: model.embeddingConfig?.model ?? 'text-embedding-3-small',
      dimensions: model.embeddingConfig?.dimensions ?? 1536,
    },
    retrievalConfig: {
      retrieverType: 'hybrid',
      vectorWeight: model.retrievalConfig?.vectorWeight ?? 0.7,
      keywordWeight: model.retrievalConfig?.keywordWeight ?? 0.3,
      topK: model.retrievalConfig?.topK ?? 10,
      scoreThreshold: model.retrievalConfig?.scoreThreshold ?? 0.5,
      enableRerank: false,
    },
    documentCount: model.documentCount,
    chunkCount: model.chunkCount ?? 0,
    totalSize: 0, // Needs separate calculation
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

/**
 * Convert Document (domain model) to KnowledgeDocumentDTO
 */
export function toKnowledgeDocumentDTO(model: Document): KnowledgeDocumentDTO {
  return {
    id: model.id,
    libraryId: model.libraryId,
    filename: model.filename,
    filePath: model.filePath,
    fileSize: model.fileSize,
    fileHash: model.fileHash,
    mediaType: model.mediaType,
    mimeType: model.mimeType,
    bibKey: model.bibKey,
    citationText: model.citationText,
    processStatus: model.processStatus,
    processedAt: model.processedAt ? toISOString(model.processedAt) : undefined,
    errorMessage: model.errorMessage,
    metadata: model.metadata ?? {},
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

/**
 * Convert SearchResult (domain model) to KnowledgeSearchResultDTO
 */
export function toKnowledgeSearchResultDTO(model: SearchResult): KnowledgeSearchResultDTO {
  const chunkMetadata: ChunkMetadataDTO = {
    page: model.chunkMetadata?.page,
    section: model.chunkMetadata?.section,
    startTime: model.chunkMetadata?.startTime,
    endTime: model.chunkMetadata?.endTime,
    speaker: model.chunkMetadata?.speaker,
    imagePath: model.chunkMetadata?.imagePath,
    extra: model.chunkMetadata?.extra,
  };

  return {
    chunkId: model.chunkId,
    documentId: model.documentId,
    libraryId: model.libraryId,
    content: model.content,
    score: model.score,
    mediaType: model.mediaType ?? 'text',
    filename: model.filename ?? '',
    chunkMetadata,
  };
}

/**
 * Convert TaskStatus (domain model) to KnowledgeTaskStatusDTO
 */
export function toKnowledgeTaskStatusDTO(model: TaskStatus): KnowledgeTaskStatusDTO {
  return {
    id: model.taskId,
    type: 'document-processing',
    status: model.status,
    progress: model.progress,
    message: model.message,
    error: model.error,
  };
}

/**
 * Convert QueueStats (domain model) to KnowledgeQueueStatsDTO
 */
export function toKnowledgeQueueStatsDTO(model: QueueStats): KnowledgeQueueStatsDTO {
  return {
    pending: model.pending,
    running: model.processing,
    completed: model.completed,
    failed: model.failed,
    cancelled: 0,
  };
}

/**
 * Convert DiagnosticsInfo (domain model) to KnowledgeDiagnosticsDTO
 */
export function toKnowledgeDiagnosticsDTO(model: DiagnosticsInfo): KnowledgeDiagnosticsDTO {
  return {
    totalChunks: model.chunkCount,
    totalEmbeddings: model.embeddingCount,
    ftsRecords: model.ftsRecords || 0,
    embeddingDimensions: model.embeddingDimensions || [],
    libraryStats: model.libraryStats || [],
  };
}

/**
 * Convert EnhancedSearchResult (domain model) to EnhancedSearchResultDTO
 */
export function toEnhancedSearchResultDTO(model: EnhancedSearchResult): EnhancedSearchResultDTO {
  return {
    results: model.results.map(toKnowledgeSearchResultDTO),
    rewrittenQuery: model.rewrittenQuery
      ? {
          original: model.rewrittenQuery,
          english: model.rewrittenQuery,
          chinese: '',
          keywords: [],
          originalLanguage: 'en',
        }
      : undefined,
    processingTime: model.processingTime,
  };
}

/**
 * Convert RAGResponse (domain model) to KnowledgeRAGResponseDTO
 */
export function toKnowledgeRAGResponseDTO(model: RAGResponse): KnowledgeRAGResponseDTO {
  return {
    answer: model.answer,
    sources: model.sources.map(toKnowledgeSearchResultDTO),
    citations: model.citations.map((c, i) => ({
      id: c.id || `cite-${i}`,
      bibKey: c.bibKey,
      text: c.text,
      source: c.source || 'unknown',
      page: c.page,
      timestamp: c.timestamp,
    })),
    context: model.context,
  };
}

/**
 * Convert AdvancedRetrievalConfig (domain model) to AdvancedRetrievalConfigDTO
 */
export function toAdvancedRetrievalConfigDTO(
  model: AdvancedRetrievalConfig
): AdvancedRetrievalConfigDTO {
  return {
    enableQueryRewrite: model.enableQueryRewrite,
    enableRerank: model.enableRerank,
    enableContextRouting: model.enableContextRouting,
    enableBilingualSearch: model.enableBilingualRetrieval,
    rerankProvider: model.rerankProvider,
    rerankModel: model.rerankModel,
  };
}

// ====== Overleaf Mappers ======

/**
 * Convert OverleafProject (domain model) to OverleafProjectDTO
 */
export function toOverleafProjectDTO(model: OverleafProject): OverleafProjectDTO {
  return {
    id: model.id,
    name: model.name,
    lastUpdated: model.lastUpdated ? toISOString(model.lastUpdated) : undefined,
    accessLevel: model.accessLevel,
  };
}

/**
 * Convert OverleafCompileResult (domain model) to OverleafCompileResultDTO
 *
 * Note: Since OverleafCompileResult and OverleafCompileResultDTO have the same structure,
 * this function is mainly for consistency and future extensibility
 */
export function toOverleafCompileResultDTO(model: OverleafCompileResult): OverleafCompileResultDTO {
  return {
    success: model.success,
    status: model.status,
    pdfData: model.pdfData,
    pdfUrl: model.pdfUrl,
    logUrl: model.logUrl,
    logContent: model.logContent,
    buildId: model.buildId,
    errors: model.errors,
    parsedErrors: model.parsedErrors,
    parsedWarnings: model.parsedWarnings,
    parsedInfo: model.parsedInfo,
  };
}

// ====== Batch Conversion Helper Functions ======

/**
 * Batch convert knowledge library list
 */
export function toKnowledgeLibraryDTOList(models: KnowledgeBase[]): KnowledgeLibraryDTO[] {
  return models.map(toKnowledgeLibraryDTO);
}

/**
 * Batch convert document list
 */
export function toKnowledgeDocumentDTOList(models: Document[]): KnowledgeDocumentDTO[] {
  return models.map(toKnowledgeDocumentDTO);
}

/**
 * Batch convert search result list
 */
export function toKnowledgeSearchResultDTOList(models: SearchResult[]): KnowledgeSearchResultDTO[] {
  return models.map(toKnowledgeSearchResultDTO);
}

/**
 * Batch convert Overleaf project list
 */
export function toOverleafProjectDTOList(models: OverleafProject[]): OverleafProjectDTO[] {
  return models.map(toOverleafProjectDTO);
}
