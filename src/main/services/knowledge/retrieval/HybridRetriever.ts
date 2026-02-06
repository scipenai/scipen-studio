/**
 * @file HybridRetriever - Hybrid Retriever
 * @description Combines vector semantic search with BM25 keyword search using RRF fusion ranking
 * @depends VectorStore, EmbeddingService, QueryRewriter, Reranker
 */

import { createLogger } from '../../LoggerService';
import type { EmbeddingService } from '../embedding/EmbeddingService';
import type { VectorStore } from '../storage/VectorStore';
import {
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
  type RetrieverType,
  type SearchParams,
  type SearchResult,
} from '../types';
import { type ContextDecision, ContextRouter, type ContextRouterConfig } from './ContextRouter';
import { QueryRewriter, type QueryRewriterConfig, type RewrittenQuery } from './QueryRewriter';
import { Reranker, type RerankerConfig } from './Reranker';

// ==================== Type Definitions ====================

/** High-level retrieval configuration */
export interface AdvancedRetrievalConfig {
  // Query Enhancement
  enableQueryRewrite: boolean;
  queryRewriterConfig?: Partial<QueryRewriterConfig>;

  // Result Enhancement
  enableRerank: boolean;
  rerankerConfig?: Partial<RerankerConfig>;

  // Smart Routing
  enableContextRouting: boolean;
  contextRouterConfig?: Partial<ContextRouterConfig>;

  // Bilingual (search in both Chinese & English)
  enableBilingualSearch: boolean;

  // LLM Config (for rewriting & routing)
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;

  // Reranker Config
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

export const DEFAULT_ADVANCED_CONFIG: AdvancedRetrievalConfig = {
  enableQueryRewrite: false,
  enableRerank: false,
  enableContextRouting: false,
  enableBilingualSearch: false,
};

/** Options for a single retrieval operation */
export interface RetrieveOptions extends SearchParams {
  vectorWeight?: number;
  keywordWeight?: number;
  enableQueryRewrite?: boolean;
  enableRerank?: boolean;
  enableContextRouting?: boolean;
  conversationHistory?: Array<{ role: string; content: string }>;
}

/** Enhanced result with metadata */
export interface EnhancedSearchResult {
  results: SearchResult[];
  rewrittenQuery?: RewrittenQuery;
  contextDecision?: ContextDecision;
  processingTime: number;
}

// ==================== Constants ====================

/**
 * RRF (Reciprocal Rank Fusion) smoothing parameter
 *
 * 🎓 ELI5: Why k=60?
 *
 * RRF formula: score = 1 / (k + rank)
 *
 * - k=0:   rank 1 gets 1.0, rank 2 gets 0.5, rank 3 gets 0.33 (too steep!)
 * - k=60:  rank 1 gets 0.0164, rank 2 gets 0.0161, rank 3 gets 0.0159 (smoother)
 *
 * k=60 prevents the top result from dominating.
 * It's from Cormack et al. (2009) paper and used by Elasticsearch.
 */
const RRF_K = 60;

// ==================== Main Class ====================

export class HybridRetriever {
  private logger = createLogger('HybridRetriever');
  private vectorStore: VectorStore;
  private embeddingService: EmbeddingService;
  private config: RetrievalConfig;
  private advancedConfig: AdvancedRetrievalConfig;

  // Advanced components (lazy initialized)
  private queryRewriter: QueryRewriter | null = null;
  private reranker: Reranker | null = null;
  private contextRouter: ContextRouter | null = null;

  constructor(
    vectorStore: VectorStore,
    embeddingService: EmbeddingService,
    config?: Partial<RetrievalConfig>,
    advancedConfig?: Partial<AdvancedRetrievalConfig>
  ) {
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    this.advancedConfig = { ...DEFAULT_ADVANCED_CONFIG, ...advancedConfig };
  }

  // ==================== Initialization ====================

  /**
   * Initialize advanced components (Query Rewriter, Reranker, Context Router)
   */
  initializeAdvancedFeatures(apiKey: string, baseUrl?: string, llmModel?: string): void {
    this.logger.info('[HybridRetriever] Initializing advanced components...');

    const effectiveBaseUrl = this.advancedConfig.llmBaseUrl || baseUrl;
    const effectiveModel = this.advancedConfig.llmModel || llmModel;

    const llmConfig = {
      apiKey: this.advancedConfig.llmApiKey || apiKey,
      baseUrl: effectiveBaseUrl,
      model: effectiveModel,
    };

    // Initialize Query Rewriter
    this.queryRewriter = new QueryRewriter({
      ...llmConfig,
      enabled: this.advancedConfig.enableQueryRewrite,
      ...this.advancedConfig.queryRewriterConfig,
    });

    // Initialize Reranker
    const rerankConfig = {
      apiKey: this.advancedConfig.rerankApiKey || apiKey,
      baseUrl: this.advancedConfig.rerankBaseUrl,
      model: this.advancedConfig.rerankModel || 'gte-rerank-v2',
      provider: this.advancedConfig.rerankProvider || 'dashscope',
    };
    this.reranker = new Reranker({
      ...rerankConfig,
      enabled: this.advancedConfig.enableRerank,
      ...this.advancedConfig.rerankerConfig,
    });

    // Initialize Context Router
    this.contextRouter = new ContextRouter({
      ...llmConfig,
      enabled: this.advancedConfig.enableContextRouting,
      ...this.advancedConfig.contextRouterConfig,
    });

    this.logger.info('[HybridRetriever] ✓ All components initialized');
  }

  /**
   * Update API configuration for advanced components
   */
  updateAdvancedApiConfig(config: {
    llmApiKey?: string;
    llmBaseUrl?: string;
    llmModel?: string;
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
  }): void {
    this.queryRewriter?.updateConfig({
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
    });

    this.reranker?.updateConfig({
      apiKey: config.rerankApiKey,
      baseUrl: config.rerankBaseUrl,
      model: config.rerankModel,
      provider: config.rerankProvider,
    });

    this.contextRouter?.updateConfig({
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
    });
  }

  /** Update basic retrieval config */
  updateConfig(config: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Update advanced retrieval config */
  updateAdvancedConfig(config: Partial<AdvancedRetrievalConfig>): void {
    this.advancedConfig = { ...this.advancedConfig, ...config };

    // Propagate enable/disable state to components
    this.queryRewriter?.updateConfig({ enabled: config.enableQueryRewrite });
    this.reranker?.updateConfig({ enabled: config.enableRerank });
    this.contextRouter?.updateConfig({ enabled: config.enableContextRouting });
  }

  // ==================== Main Retrieval Pipeline ====================

  /**
   * Execute enhanced retrieval (full pipeline)
   *
   * ╔═══════════════════════════════════════════════════════════════════╗
   * ║  📋 RETRIEVAL PIPELINE (Step by Step):                           ║
   * ║                                                                   ║
   * ║  User Query: "What's the best way to train a neural network?"    ║
   * ║                                                                   ║
   * ║  Step 1: ROUTING (Optional)                                      ║
   * ║    → "This needs detailed context" → increase topK to 10         ║
   * ║                                                                   ║
   * ║  Step 2: QUERY REWRITE (Optional)                                ║
   * ║    → "neural network training best practices optimization"       ║
   * ║    → (English + Chinese versions)                                ║
   * ║                                                                   ║
   * ║  Step 3: SEARCH (Core)                                           ║
   * ║    → Vector search: finds semantically similar chunks            ║
   * ║    → Keyword search: finds exact term matches                    ║
   * ║    → Hybrid: combines both (default)                             ║
   * ║                                                                   ║
   * ║  Step 4: MERGE (if multiple queries)                             ║
   * ║    → RRF fusion: combine results from different searches         ║
   * ║                                                                   ║
   * ║  Step 5: RERANK (Optional)                                       ║
   * ║    → Ask LLM: "Which of these is most relevant?"                 ║
   * ║                                                                   ║
   * ║  Step 6: POST-PROCESS                                            ║
   * ║    → Filter by score threshold                                   ║
   * ║    → Expand with adjacent chunks (if needed)                     ║
   * ║    → Diversify (ensure results from different documents)         ║
   * ║                                                                   ║
   * ╚═══════════════════════════════════════════════════════════════════╝
   */
  async retrieveEnhanced(options: RetrieveOptions): Promise<EnhancedSearchResult> {
    const startTime = Date.now();

    // Extract options with defaults
    const params = this.extractRetrievalParams(options);

    this.logRetrievalStart(params);

    // ═══════════ STEP 1: Context Routing ═══════════
    const { contextDecision, adjustedParams } = await this.runContextRouting(params);

    // Short-circuit if routing says "no context needed"
    if (contextDecision?.contextType === 'none') {
      return this.createEmptyResult(contextDecision, startTime);
    }

    // ═══════════ STEP 2: Query Rewriting ═══════════
    const { rewrittenQuery, searchQueries } = await this.runQueryRewriting(params);

    // ═══════════ STEP 3: Execute Searches ═══════════
    const rawResults = await this.executeSearches(searchQueries, adjustedParams, params);

    // ═══════════ STEP 4: Merge Results ═══════════
    let mergedResults = this.mergeMultipleResultSets(rawResults);

    // ═══════════ STEP 5: Reranking ═══════════
    mergedResults = await this.runReranking(
      mergedResults,
      rewrittenQuery?.original || params.query,
      adjustedParams,
      params.enableRerank
    );

    // ═══════════ STEP 6: Post-processing ═══════════
    const finalResults = await this.postProcessResults(
      mergedResults,
      adjustedParams,
      params.scoreThreshold
    );

    return {
      results: finalResults,
      rewrittenQuery,
      contextDecision,
      processingTime: Date.now() - startTime,
    };
  }

  /**
   * Simple retrieval (backwards compatible)
   */
  async retrieve(options: RetrieveOptions): Promise<SearchResult[]> {
    const enhanced = await this.retrieveEnhanced(options);
    return enhanced.results;
  }

  // ==================== Pipeline Steps (Private) ====================

  /**
   * Extract and normalize retrieval parameters
   */
  private extractRetrievalParams(options: RetrieveOptions) {
    return {
      query: options.query,
      libraryIds: options.libraryIds,
      topK: options.topK ?? this.config.topK,
      scoreThreshold: options.scoreThreshold ?? this.config.scoreThreshold,
      retrieverType: options.retrieverType ?? this.config.retrieverType,
      vectorWeight: options.vectorWeight ?? this.config.vectorWeight,
      keywordWeight: options.keywordWeight ?? this.config.keywordWeight,
      excludeChunkIds: options.excludeChunkIds ?? [],
      enableQueryRewrite: options.enableQueryRewrite ?? this.advancedConfig.enableQueryRewrite,
      enableRerank: options.enableRerank ?? this.advancedConfig.enableRerank,
      enableContextRouting:
        options.enableContextRouting ?? this.advancedConfig.enableContextRouting,
      conversationHistory: options.conversationHistory ?? [],
    };
  }

  /**
   * Log retrieval start (for debugging)
   */
  private logRetrievalStart(params: ReturnType<typeof this.extractRetrievalParams>): void {
    this.logger.info('[HybridRetriever] ========== Starting Retrieval ==========');
    this.logger.info(`[HybridRetriever] Query: ${params.query?.slice(0, 50)}...`);
    this.logger.info('[HybridRetriever] Libraries:', params.libraryIds);
    this.logger.info(`[HybridRetriever] Type: ${params.retrieverType}, topK: ${params.topK}`);
  }

  /**
   * Step 1: Run context routing to determine retrieval strategy
   *
   * 🎓 ELI5: Some questions need more context than others.
   * - "What is 2+2?" → needs no documents (none)
   * - "Who wrote Paper X?" → needs 1-2 snippets (snippet)
   * - "Explain the entire theory" → needs many paragraphs (extended)
   */
  private async runContextRouting(params: ReturnType<typeof this.extractRetrievalParams>): Promise<{
    contextDecision: ContextDecision | undefined;
    adjustedParams: { topK: number; includeAdjacent: boolean; diversify: boolean };
  }> {
    let contextDecision: ContextDecision | undefined;
    let adjustedTopK = params.topK;
    let includeAdjacent = false;
    let diversify = false;

    if (params.enableContextRouting && this.contextRouter) {
      contextDecision = await this.contextRouter.route(params.query);

      const retrievalParams = this.contextRouter.getRetrievalParams(contextDecision);
      adjustedTopK = retrievalParams.topK;
      includeAdjacent = retrievalParams.includeAdjacent;
      diversify = retrievalParams.diversify;

      this.logger.info('[HybridRetriever] Context routing:', contextDecision.contextType);
    }

    return {
      contextDecision,
      adjustedParams: { topK: adjustedTopK, includeAdjacent, diversify },
    };
  }

  /**
   * Step 2: Rewrite query for better search results
   *
   * 🎓 ELI5: Sometimes users ask questions in weird ways.
   * "what's that thing for training AI" → "machine learning model training methods"
   */
  private async runQueryRewriting(params: ReturnType<typeof this.extractRetrievalParams>): Promise<{
    rewrittenQuery: RewrittenQuery | undefined;
    searchQueries: string[];
  }> {
    let rewrittenQuery: RewrittenQuery | undefined;
    let searchQueries: string[] = [params.query];

    if (params.enableQueryRewrite && this.queryRewriter) {
      this.logger.info('[HybridRetriever] Rewriting query...');
      rewrittenQuery = await this.queryRewriter.rewrite(params.query, params.conversationHistory);

      if (this.advancedConfig.enableBilingualSearch && rewrittenQuery) {
        // Use all language variants for search
        searchQueries = this.deduplicateQueries([
          rewrittenQuery.original,
          rewrittenQuery.english,
          rewrittenQuery.chinese,
        ]);
        this.logger.info('[HybridRetriever] Bilingual queries:', searchQueries.length);
      } else if (rewrittenQuery) {
        searchQueries = [rewrittenQuery.original];
      }
    }

    return { rewrittenQuery, searchQueries };
  }

  /**
   * Remove duplicate queries
   */
  private deduplicateQueries(queries: (string | undefined)[]): string[] {
    return [...new Set(queries)].filter((q): q is string => q !== undefined && q.trim().length > 0);
  }

  /**
   * Step 3: Execute searches for all queries
   */
  private async executeSearches(
    searchQueries: string[],
    adjustedParams: { topK: number },
    params: ReturnType<typeof this.extractRetrievalParams>
  ): Promise<SearchResult[][]> {
    // Fetch more candidates if reranking (reranker will pick best)
    const fetchTopK = params.enableRerank ? adjustedParams.topK * 2 : adjustedParams.topK;
    // Use lower threshold initially (will filter later)
    const looseThreshold = Math.min(params.scoreThreshold * 0.5, 0.1);

    const searchPromises = searchQueries.map((q) =>
      this.executeSearch(q, {
        libraryIds: params.libraryIds,
        topK: fetchTopK,
        threshold: looseThreshold,
        retrieverType: params.retrieverType,
        vectorWeight: params.vectorWeight,
        keywordWeight: params.keywordWeight,
        excludeChunkIds: params.excludeChunkIds,
      })
    );

    return Promise.all(searchPromises);
  }

  /**
   * Execute a single search (vector, keyword, or hybrid)
   */
  private async executeSearch(
    query: string,
    options: {
      libraryIds?: string[];
      topK?: number;
      threshold?: number;
      retrieverType?: RetrieverType;
      vectorWeight?: number;
      keywordWeight?: number;
      excludeChunkIds?: string[];
    }
  ): Promise<SearchResult[]> {
    const { retrieverType = 'hybrid' } = options;

    switch (retrieverType) {
      case 'vector':
        return this.vectorSearch(query, options);
      case 'keyword':
        return this.keywordSearch(query, options);
      default:
        return this.hybridSearch(query, options);
    }
  }

  /**
   * Step 5: Run reranking on results
   *
   * 🎓 ELI5: Initial search is fast but rough.
   * Reranking asks a smarter model: "Which of these ACTUALLY answers the question?"
   */
  private async runReranking(
    results: SearchResult[],
    query: string,
    adjustedParams: { topK: number },
    enableRerank: boolean
  ): Promise<SearchResult[]> {
    if (!enableRerank || !this.reranker || results.length === 0) {
      return results;
    }

    this.logger.info(`[HybridRetriever] Reranking ${results.length} results...`);

    const rerankedResults = await this.reranker.rerank(
      query,
      results.map((r, i) => ({
        content: r.content,
        score: r.score,
        index: i,
      })),
      adjustedParams.topK
    );

    // Reorder results by reranker scores
    return rerankedResults.map((rr) => ({
      ...results[rr.index],
      score: rr.score,
    }));
  }

  /**
   * Step 6: Post-process results (filter, expand, diversify)
   */
  private async postProcessResults(
    results: SearchResult[],
    adjustedParams: { topK: number; includeAdjacent: boolean; diversify: boolean },
    scoreThreshold: number
  ): Promise<SearchResult[]> {
    // Filter by score (use more lenient threshold)
    const effectiveThreshold = Math.min(scoreThreshold, 0.1);
    let finalResults = results
      .filter((r) => r.score >= effectiveThreshold)
      .slice(0, adjustedParams.topK);

    this.logger.info(`[HybridRetriever] After filtering: ${finalResults.length} results`);

    // Expand with adjacent chunks if needed
    if (adjustedParams.includeAdjacent && finalResults.length > 0) {
      finalResults = await this.expandWithAdjacentChunks(finalResults);
    }

    // Diversify results (spread across documents)
    if (adjustedParams.diversify && finalResults.length > 1) {
      finalResults = this.diversifyResults(finalResults);
    }

    return finalResults;
  }

  /**
   * Create empty result (used when routing says "no context needed")
   */
  private createEmptyResult(
    contextDecision: ContextDecision,
    startTime: number
  ): EnhancedSearchResult {
    return {
      results: [],
      contextDecision,
      processingTime: Date.now() - startTime,
    };
  }

  // ==================== Search Methods ====================

  /**
   * Vector search: find semantically similar content
   *
   * 🎓 ELI5: Convert query to numbers (embedding).
   * Find documents whose numbers are closest to query's numbers.
   * Close numbers = similar meaning!
   */
  private async vectorSearch(
    query: string,
    options: {
      libraryIds?: string[];
      topK?: number;
      threshold?: number;
      excludeChunkIds?: string[];
    }
  ): Promise<SearchResult[]> {
    this.logger.info('[HybridRetriever] Vector search...');

    // Step 1: Convert query text to numbers (embedding)
    const embedResult = await this.embeddingService.embed(query);

    // Step 2: Find similar vectors in database
    const vectorResults = await this.vectorStore.searchByVectorAsync({
      embedding: embedResult.embedding,
      libraryIds: options.libraryIds,
      topK: options.topK,
      threshold: options.threshold,
      excludeChunkIds: options.excludeChunkIds,
    });

    // Step 3: Fetch full content for matched chunks
    const chunkIds = vectorResults.map((r) => r.chunkId);
    const searchResults = await this.vectorStore.getSearchResultsAsync(chunkIds);

    // Step 4: Attach scores
    return searchResults.map((result, index) => ({
      ...result,
      score: vectorResults[index]?.score || 0,
    }));
  }

  /**
   * Keyword search: find exact word matches (BM25)
   *
   * 🎓 ELI5: Look for documents containing the query words.
   * Documents with rare words get higher scores.
   * "neural network paper" → high score if document has all 3 words
   */
  private async keywordSearch(
    query: string,
    options: {
      libraryIds?: string[];
      topK?: number;
      excludeChunkIds?: string[];
    }
  ): Promise<SearchResult[]> {
    this.logger.info('[HybridRetriever] Keyword search...');

    // Use SQLite FTS5 for keyword matching
    const keywordResults = await this.vectorStore.searchByKeywordAsync(
      query,
      options.libraryIds,
      options.topK,
      options.excludeChunkIds
    );

    // Fetch full content
    const chunkIds = keywordResults.map((r) => r.chunkId);
    const searchResults = await this.vectorStore.getSearchResultsAsync(chunkIds);

    // Normalize scores to 0-1 range
    const maxScore =
      keywordResults.length > 0 ? Math.max(...keywordResults.map((r) => r.score)) : 1;

    return searchResults.map((result, index) => ({
      ...result,
      score: (keywordResults[index]?.score || 0) / maxScore,
      highlights: keywordResults[index]?.highlights,
    }));
  }

  /**
   * Hybrid search: combine vector + keyword
   *
   * 🎓 ELI5: Best of both worlds!
   *
   * Vector search finds "similar meaning" matches.
   * Keyword search finds "exact word" matches.
   *
   * Combined score = (vector_score × 0.7) + (keyword_score × 0.3)
   *
   * Why 70/30 split?
   * - Semantic understanding is usually more important
   * - But exact matches shouldn't be ignored (technical terms!)
   */
  private async hybridSearch(
    query: string,
    options: {
      libraryIds?: string[];
      topK?: number;
      threshold?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      excludeChunkIds?: string[];
    }
  ): Promise<SearchResult[]> {
    this.logger.info('[HybridRetriever] Hybrid search...');

    const {
      libraryIds,
      topK = 10,
      threshold = 0.1,
      vectorWeight = 0.7,
      keywordWeight = 0.3,
      excludeChunkIds = [],
    } = options;

    this.logger.info(`[HybridRetriever] Weights: vector=${vectorWeight}, keyword=${keywordWeight}`);

    // Get query embedding
    const embedResult = await this.embeddingService.embed(query);

    // Execute hybrid search (combines both in database)
    const hybridResults = await this.vectorStore.hybridSearchAsync(embedResult.embedding, query, {
      libraryIds,
      topK,
      vectorWeight,
      keywordWeight,
      threshold: Math.min(threshold, 0.1),
      excludeChunkIds,
    });

    // Fetch full content
    const chunkIds = hybridResults.map((r) => r.chunkId);
    const searchResults = await this.vectorStore.getSearchResultsAsync(chunkIds);

    return searchResults.map((result, index) => ({
      ...result,
      score: hybridResults[index]?.score || 0,
    }));
  }

  // ==================== Result Processing ====================

  /**
   * Merge multiple result sets using RRF (Reciprocal Rank Fusion)
   *
   * ╔═══════════════════════════════════════════════════════════════════╗
   * ║  🎓 ELI5: RRF Explained                                          ║
   * ║                                                                   ║
   * ║  Imagine 3 judges ranking contestants:                           ║
   * ║                                                                   ║
   * ║  Judge A: [Alice=1st, Bob=2nd, Charlie=3rd]                      ║
   * ║  Judge B: [Bob=1st, Charlie=2nd, Alice=3rd]                      ║
   * ║  Judge C: [Charlie=1st, Alice=2nd, Bob=3rd]                      ║
   * ║                                                                   ║
   * ║  Simple average? Alice: (1+3+2)/3 = 2.0                          ║
   * ║  But wait - ranking scales differ between judges!                ║
   * ║                                                                   ║
   * ║  RRF solution: score = 1/(k+rank)                                ║
   * ║  Alice: 1/(60+1) + 1/(60+3) + 1/(60+2) = 0.0163 + 0.0159 + 0.0161║
   * ║                                                                   ║
   * ║  This normalizes across different scales automatically!          ║
   * ╚═══════════════════════════════════════════════════════════════════╝
   */
  private mergeMultipleResultSets(resultSets: SearchResult[][]): SearchResult[] {
    // Filter empty sets
    const nonEmptySets = resultSets.filter((set) => set.length > 0);

    // Single set: return as-is (preserve original scores)
    if (nonEmptySets.length === 1) {
      return nonEmptySets[0];
    }

    // No results
    if (nonEmptySets.length === 0) {
      return [];
    }

    // Multiple sets: use RRF fusion
    this.logger.info(`[HybridRetriever] Merging ${nonEmptySets.length} result sets with RRF`);
    return this.reciprocalRankFusion(nonEmptySets);
  }

  /**
   * Reciprocal Rank Fusion implementation
   */
  private reciprocalRankFusion(resultSets: SearchResult[][]): SearchResult[] {
    // Map: chunkId → { result, rrfScore, maxOriginalScore }
    const scoreMap = new Map<
      string,
      {
        result: SearchResult;
        rrfScore: number;
        maxOriginalScore: number;
      }
    >();

    // Calculate RRF scores
    for (const results of resultSets) {
      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        const rrfContribution = this.calculateRRFScore(rank);

        const existing = scoreMap.get(result.chunkId);
        if (existing) {
          // Accumulate RRF score
          existing.rrfScore += rrfContribution;
          // Keep the best original score
          if (result.score > existing.maxOriginalScore) {
            existing.maxOriginalScore = result.score;
            existing.result = result;
          }
        } else {
          scoreMap.set(result.chunkId, {
            result,
            rrfScore: rrfContribution,
            maxOriginalScore: result.score,
          });
        }
      }
    }

    // Sort by RRF score, but return original scores for filtering
    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map((item) => ({
        ...item.result,
        score: item.maxOriginalScore, // Preserve original for threshold filtering
      }));
  }

  /**
   * Calculate RRF score for a given rank
   *
   * Formula: 1 / (k + rank + 1)
   * Note: rank is 0-indexed, so we add 1
   */
  private calculateRRFScore(rank: number): number {
    return 1 / (RRF_K + rank + 1);
  }

  /**
   * Expand results with adjacent chunks (for context)
   *
   * 🎓 ELI5: Sometimes the answer spans multiple chunks.
   * If chunk 5 is relevant, chunks 4 and 6 might add useful context.
   */
  private async expandWithAdjacentChunks(results: SearchResult[]): Promise<SearchResult[]> {
    const expandedChunkIds = new Set<string>();
    const chunkIdToResult = new Map<string, SearchResult>();

    // Collect original + adjacent chunk IDs
    for (const result of results) {
      chunkIdToResult.set(result.chunkId, result);
      expandedChunkIds.add(result.chunkId);

      const chunk = await this.vectorStore.getChunkById(result.chunkId);
      if (chunk) {
        if (chunk.prevChunkId) expandedChunkIds.add(chunk.prevChunkId);
        if (chunk.nextChunkId) expandedChunkIds.add(chunk.nextChunkId);
      }
    }

    // Fetch all chunks
    const allResults = await this.vectorStore.getSearchResultsAsync(Array.from(expandedChunkIds));

    // Preserve original scores, assign medium score to adjacent chunks
    return allResults.map((r) => ({
      ...r,
      score: chunkIdToResult.get(r.chunkId)?.score || 0.5,
    }));
  }

  /**
   * Diversify results (ensure coverage across documents)
   *
   * 🎓 ELI5: Don't return 10 chunks from the same document!
   * Spread results across different sources for broader coverage.
   */
  private diversifyResults(results: SearchResult[]): SearchResult[] {
    const seenDocuments = new Set<string>();
    const diversified: SearchResult[] = [];
    const remaining: SearchResult[] = [];

    // First pass: one result per document
    for (const result of results) {
      if (!seenDocuments.has(result.documentId)) {
        seenDocuments.add(result.documentId);
        diversified.push(result);
      } else {
        remaining.push(result);
      }
    }

    // Second pass: fill with remaining (by score order)
    const finalResults = [...diversified, ...remaining];
    this.logger.info(`[HybridRetriever] Diversified: from ${seenDocuments.size} documents`);

    return finalResults;
  }

  // ==================== Formatting Utilities ====================

  /**
   * Format results as context string (for LLM input)
   */
  formatAsContext(results: SearchResult[]): string {
    if (results.length === 0) return '';

    return results
      .map((r, i) => {
        const source = this.formatSource(r);
        return `[Reference ${i + 1}] ${source}\n${r.content}`;
      })
      .join('\n\n---\n\n');
  }

  /**
   * Format source information
   */
  private formatSource(result: SearchResult): string {
    const parts: string[] = [result.filename];

    if (result.chunkMetadata?.page) {
      parts.push(`Page ${result.chunkMetadata.page}`);
    }

    if (result.chunkMetadata?.startTime !== undefined) {
      parts.push(`Time ${this.formatTimestamp(result.chunkMetadata.startTime)}`);
    }

    if (result.bibKey) {
      parts.push(`[${result.bibKey}]`);
    }

    parts.push(`(${(result.score * 100).toFixed(1)}%)`);

    return parts.join(' - ');
  }

  /**
   * Format seconds as MM:SS
   */
  private formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Extract citations from results
   */
  extractCitations(results: SearchResult[]): Array<{
    bibKey: string;
    text: string;
    source: string;
  }> {
    return results
      .filter((r) => r.bibKey)
      .map((r) => ({
        bibKey: r.bibKey!,
        text: r.citationText || r.filename,
        source: r.filename,
      }));
  }
}
