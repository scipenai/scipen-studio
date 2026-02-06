/**
 * @file Knowledge Module Entry - Multimodal Knowledge Base Module
 * @description Exports knowledge base service, storage, embedding, processors, retrieval components
 * @depends MultimodalKnowledgeService, VectorStore, DocumentStore, processors, retrieval
 */

export {
  MultimodalKnowledgeService,
  getKnowledgeService,
  type InitOptions,
} from './MultimodalKnowledgeService';

export * from './types';

export {
  VectorStore,
  type VectorStoreConfig,
  type VectorSearchOptions,
} from './storage/VectorStore';
export { DocumentStore } from './storage/DocumentStore';

export {
  EmbeddingService,
  type EmbedOptions,
  type EmbedResult,
} from './embedding/EmbeddingService';

export {
  BaseProcessor,
  type ProcessorContext,
  type ProcessorOptions,
} from './processors/BaseProcessor';
export { TextProcessor } from './processors/TextProcessor';
export { PDFProcessor } from './processors/PDFProcessor';
export { AudioProcessor, type AudioProcessorConfig } from './processors/AudioProcessor';
export { ImageProcessor, type ImageProcessorConfig } from './processors/ImageProcessor';

export {
  HybridRetriever,
  type RetrieveOptions,
  type EnhancedSearchResult,
  type AdvancedRetrievalConfig,
  DEFAULT_ADVANCED_CONFIG,
} from './retrieval/HybridRetriever';
export {
  QueryRewriter,
  type RewrittenQuery,
  type QueryRewriterConfig,
} from './retrieval/QueryRewriter';
export { Reranker, type RerankResult, type RerankerConfig } from './retrieval/Reranker';
export {
  ContextRouter,
  type ContextDecision,
  type ContextRouterConfig,
  type ContextType,
} from './retrieval/ContextRouter';

export { TaskQueue, type TaskHandler, type ProgressCallback } from './queue/TaskQueue';
