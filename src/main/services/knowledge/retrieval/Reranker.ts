/**
 * @file Reranker - Retrieval Result Reranker
 * @description Supports multiple reranking strategies: DashScope/Cohere/Jina/OpenAI/local keyword
 * @depends LoggerService
 */

import { createLogger } from '../../LoggerService';

const logger = createLogger('Reranker');

// ====== Types ======

export interface RerankResult {
  index: number;
  score: number;
  content: string;
}

interface DashScopeRerankResponse {
  output?: {
    results?: Array<{
      index: number;
      relevance_score: number;
    }>;
  };
}

interface RerankAPIResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}

interface LLMChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface RerankerConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  provider?:
    | 'dashscope'
    | 'openai'
    | 'cohere'
    | 'jina'
    | 'local'
    | 'siliconflow'
    | 'aihubmix'
    | 'custom';
  enabled?: boolean;
  maxDocuments?: number;
}

// ====== Main Class ======

export class Reranker {
  private config: RerankerConfig;
  private readonly MAX_TOKENS_PER_DOC = 500;
  private readonly BATCH_SIZE = 10;

  constructor(config: RerankerConfig) {
    this.config = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gte-rerank-v2',
      provider: 'dashscope',
      enabled: true,
      maxDocuments: 20,
      ...config,
    };
  }

  updateConfig(config: Partial<RerankerConfig>): void {
    if (config.apiKey !== undefined) this.config.apiKey = config.apiKey;
    if (config.baseUrl !== undefined) this.config.baseUrl = config.baseUrl;
    if (config.model !== undefined) this.config.model = config.model;
    if (config.provider !== undefined) this.config.provider = config.provider;
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
    if (config.maxDocuments !== undefined) this.config.maxDocuments = config.maxDocuments;
  }

  getConfig(): RerankerConfig {
    return { ...this.config };
  }

  async rerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK = 5
  ): Promise<RerankResult[]> {
    logger.info(`[Reranker] Starting rerank, docs: ${documents.length}, topK: ${topK}`);
    logger.info(`[Reranker] Provider: ${this.config.provider}, Model: ${this.config.model}`);

    if (!this.config.enabled || documents.length <= topK) {
      logger.info('[Reranker] Skipped (disabled or insufficient docs)');
      return documents.slice(0, topK).map((doc) => ({
        index: doc.index,
        score: doc.score,
        content: doc.content,
      }));
    }

    if (!this.config.apiKey) {
      logger.info('[Reranker] No API key, using local rerank');
      return this.localRerank(query, documents, topK);
    }

    try {
      const limitedDocs = documents.slice(0, this.config.maxDocuments || 20);

      switch (this.config.provider) {
        case 'dashscope':
          return await this.dashscopeRerank(query, limitedDocs, topK);
        case 'cohere':
          return await this.cohereRerank(query, limitedDocs, topK);
        case 'jina':
          return await this.jinaRerank(query, limitedDocs, topK);
        case 'openai':
          return await this.llmRerank(query, limitedDocs, topK);
        case 'siliconflow':
        case 'aihubmix':
        case 'custom':
          // OpenAI-compatible providers use the generic rerank API
          return await this.genericRerank(query, limitedDocs, topK);
        default:
          // 'local' and any unknown providers use local reranking
          return this.localRerank(query, limitedDocs, topK);
      }
    } catch (error) {
      console.error('[Reranker] Rerank failed:', error);
      return this.localRerank(query, documents, topK);
    }
  }

  // ====== Provider-Specific Methods ======

  private async dashscopeRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): Promise<RerankResult[]> {
    logger.info('[Reranker] Calling DashScope Rerank API...');

    const response = await fetch(
      'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'gte-rerank-v2',
          input: {
            query,
            documents: documents.map((d) => d.content.slice(0, 2000)),
          },
          parameters: {
            return_documents: false,
            top_n: topK,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Reranker] DashScope API error:', response.status, errorText);
      throw new Error(`DashScope API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as DashScopeRerankResponse;
    logger.info('[Reranker] DashScope response:', JSON.stringify(data).slice(0, 200));

    const results = data.output?.results || [];

    logger.info('[Reranker] ✓ DashScope rerank complete, results:', results.length);

    return results.map((result) => ({
      index: documents[result.index].index,
      score: result.relevance_score,
      content: documents[result.index].content,
    }));
  }

  private async llmRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): Promise<RerankResult[]> {
    // Process in batches
    const batches = this.splitIntoBatches(documents, this.BATCH_SIZE);
    const allResults: RerankResult[] = [];

    for (const batch of batches) {
      const batchResults = await this.rerankBatch(query, batch);
      allResults.push(...batchResults);
    }

    // Sort by score and return topK
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, topK);
  }

  private async rerankBatch(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>
  ): Promise<RerankResult[]> {
    const systemPrompt = `You are a relevance scoring assistant. Your task is to score how relevant each document is to the given query.

Score each document from 0.0 to 1.0 where:
- 1.0 = Highly relevant, directly answers the query
- 0.7-0.9 = Relevant, contains useful information
- 0.4-0.6 = Partially relevant, some related content
- 0.1-0.3 = Marginally relevant, loosely related
- 0.0 = Not relevant at all

Respond with a JSON array of scores in the same order as the documents:
{"scores": [0.8, 0.3, 0.9, ...]}`;

    // Build document list
    const docsText = documents
      .map((doc, i) => {
        const truncated = doc.content.slice(0, this.MAX_TOKENS_PER_DOC * 4);
        return `Document ${i + 1}:\n${truncated}`;
      })
      .join('\n\n---\n\n');

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Query: "${query}"\n\n${docsText}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`Rerank API error: ${response.status}`);
    }

    const data = (await response.json()) as LLMChatResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from reranker');
    }

    const parsed = JSON.parse(content) as { scores?: number[] };
    const scores = parsed.scores || [];

    return documents.map((doc, i) => ({
      index: doc.index,
      score: scores[i] ?? doc.score,
      content: doc.content,
    }));
  }

  private async cohereRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): Promise<RerankResult[]> {
    const response = await fetch('https://api.cohere.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        documents: documents.map((d) => d.content),
        top_n: topK,
        model: this.config.model || 'rerank-multilingual-v3.0',
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere API error: ${response.status}`);
    }

    const data = (await response.json()) as RerankAPIResponse;

    return data.results.map((result) => ({
      index: documents[result.index].index,
      score: result.relevance_score,
      content: documents[result.index].content,
    }));
  }

  private async jinaRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): Promise<RerankResult[]> {
    const response = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        documents: documents.map((d) => d.content),
        top_n: topK,
        model: this.config.model || 'jina-reranker-v2-base-multilingual',
      }),
    });

    if (!response.ok) {
      throw new Error(`Jina API error: ${response.status}`);
    }

    const data = (await response.json()) as RerankAPIResponse;

    return data.results.map((result) => ({
      index: documents[result.index].index,
      score: result.relevance_score,
      content: documents[result.index].content,
    }));
  }

  /** Generic OpenAI-compatible rerank (siliconflow, aihubmix, custom) */
  private async genericRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): Promise<RerankResult[]> {
    const baseUrl = this.config.baseUrl?.replace(/\/$/, '') || 'https://api.siliconflow.cn/v1';
    const endpoint = `${baseUrl}/rerank`;

    logger.info(`[Reranker] Calling Generic Rerank API: ${endpoint}`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        documents: documents.map((d) => d.content.slice(0, 2000)),
        top_n: topK,
        model: this.config.model || 'BAAI/bge-reranker-v2-m3',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Reranker] Generic Rerank API error:', response.status, errorText);
      throw new Error(`Generic Rerank API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as RerankAPIResponse;
    logger.info('[Reranker] ✓ Generic rerank complete, results:', data.results?.length || 0);

    return (data.results || []).map((result) => ({
      index: documents[result.index].index,
      score: result.relevance_score,
      content: documents[result.index].content,
    }));
  }

  // ====== Local Fallback ======

  /** Local reranking using keyword matching and position weighting */
  private localRerank(
    query: string,
    documents: Array<{ content: string; score: number; index: number }>,
    topK: number
  ): RerankResult[] {
    const queryTerms = this.tokenize(query);

    const scored = documents.map((doc) => {
      const docTerms = this.tokenize(doc.content);
      const matchScore = this.calculateTermMatch(queryTerms, docTerms);
      const positionScore = this.calculatePositionScore(query, doc.content);

      const originalWeight = 0.4;
      const matchWeight = 0.4;
      const positionWeight = 0.2;

      const finalScore =
        doc.score * originalWeight + matchScore * matchWeight + positionScore * positionWeight;

      return {
        index: doc.index,
        score: finalScore,
        content: doc.content,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ====== Utility Methods ======

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  }

  private calculateTermMatch(queryTerms: string[], docTerms: string[]): number {
    const docTermSet = new Set(docTerms);
    let matches = 0;

    for (const term of queryTerms) {
      if (docTermSet.has(term)) {
        matches++;
      }
    }

    return queryTerms.length > 0 ? matches / queryTerms.length : 0;
  }

  /** Higher score for matches near the beginning of content */
  private calculatePositionScore(query: string, content: string): number {
    const lowerQuery = query.toLowerCase();
    const lowerContent = content.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
    let totalScore = 0;

    for (const word of queryWords) {
      const index = lowerContent.indexOf(word);
      if (index !== -1) {
        const posScore = 1 - Math.min(index / 500, 1);
        totalScore += posScore;
      }
    }

    return queryWords.length > 0 ? totalScore / queryWords.length : 0;
  }

  private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}
