/**
 * @file EmbeddingService - Text Vector Embedding Service
 * @description Supports multiple embedding models (OpenAI, Ollama, etc.) with batch embedding and caching
 * @depends EmbeddingConfig
 */

import { createLogger } from '../../LoggerService';
import type { EmbeddingConfig } from '../types';

const logger = createLogger('EmbeddingService');

/** OpenAI Embedding API response type */
interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage?: {
    total_tokens: number;
  };
}

/** Ollama Embedding API response type */
interface OllamaEmbeddingResponse {
  embedding: number[];
}

/** Embedding request options */
export interface EmbedOptions {
  model?: string;
  dimensions?: number;
  batchSize?: number;
}

/** Embedding result */
export interface EmbedResult {
  embedding: number[];
  model: string;
  tokenCount?: number;
}

export class EmbeddingService {
  private config: EmbeddingConfig;
  private cache: Map<string, number[]> = new Map();
  private cacheMaxSize = 10000;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  /**
   * Get current configuration
   */
  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * Get API Key
   */
  getApiKey(): string | undefined {
    return this.config.apiKey;
  }

  /**
   * Get Base URL
   */
  getBaseUrl(): string {
    return this.config.baseUrl || 'https://api.openai.com/v1';
  }

  /**
   * Update configuration
   * Note: Only updates non-undefined values to avoid overwriting existing configuration
   */
  updateConfig(config: Partial<EmbeddingConfig>): void {
    logger.info('[EmbeddingService] Updating configuration');
    logger.info('[EmbeddingService] Current configuration:', {
      provider: this.config.provider,
      model: this.config.model,
      hasApiKey: !!this.config.apiKey,
      baseUrl: this.config.baseUrl,
    });
    logger.info('[EmbeddingService] Update items:', {
      provider: config.provider !== undefined ? config.provider : '(no update)',
      apiKey: config.apiKey !== undefined ? (config.apiKey ? 'set' : 'cleared') : '(no update)',
      baseUrl: config.baseUrl !== undefined ? config.baseUrl || 'cleared' : '(no update)',
      model: config.model !== undefined ? config.model : '(no update)',
    });

    // Only update non-undefined values to avoid accidental overwrites
    if (config.provider !== undefined) {
      this.config.provider = config.provider;
    }
    if (config.apiKey !== undefined) {
      this.config.apiKey = config.apiKey;
    }
    if (config.baseUrl !== undefined) {
      this.config.baseUrl = config.baseUrl;
    }
    if (config.model !== undefined) {
      this.config.model = config.model;
    }
    if (config.dimensions !== undefined) {
      this.config.dimensions = config.dimensions;
    }

    logger.info('[EmbeddingService] ✓ Configuration updated:');
    logger.info('[EmbeddingService]   Provider:', this.config.provider);
    logger.info('[EmbeddingService]   Model:', this.config.model);
    logger.info(
      '[EmbeddingService]   API Key:',
      this.config.apiKey ? 'configured' : 'not configured'
    );
    logger.info('[EmbeddingService]   Base URL:', this.config.baseUrl || '(default)');
  }

  /**
   * Get embedding vector for a single text
   */
  async embed(text: string, options?: EmbedOptions): Promise<EmbedResult> {
    const cacheKey = this.getCacheKey(text);

    // Check cache
    if (this.cache.has(cacheKey)) {
      return {
        embedding: this.cache.get(cacheKey)!,
        model: this.config.model,
      };
    }

    const result = await this.callEmbeddingAPI([text], options);

    if (result.length > 0) {
      this.addToCache(cacheKey, result[0].embedding);
      return result[0];
    }

    throw new Error('Failed to generate embedding');
  }

  /**
   * Batch get embedding vectors
   * Note: Different APIs have different batch size limits
   * - OpenAI: maximum 2048
   * - Alibaba Cloud DashScope: maximum 10
   * - Other compatible APIs: recommended to use 10
   */
  async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbedResult[]> {
    // Default batch size changed to 10 to be compatible with APIs with smaller limits like DashScope
    const batchSize = options?.batchSize || 10;
    const results: EmbedResult[] = [];

    logger.info(
      `[EmbeddingService] Batch embedding: ${texts.length} texts, batch size: ${batchSize}`
    );

    // Process in batches
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      logger.info(
        `[EmbeddingService] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}, current batch: ${batch.length}`
      );

      const batchResults = await this.callEmbeddingAPI(batch, options);
      results.push(...batchResults);

      // Add to cache
      for (let j = 0; j < batch.length; j++) {
        const cacheKey = this.getCacheKey(batch[j]);
        this.addToCache(cacheKey, batchResults[j].embedding);
      }
    }

    logger.info(`[EmbeddingService] ✓ Batch embedding complete: ${results.length} vectors`);
    return results;
  }

  /**
   * Call embedding API
   */
  private async callEmbeddingAPI(texts: string[], options?: EmbedOptions): Promise<EmbedResult[]> {
    switch (this.config.provider) {
      case 'openai':
        return this.callOpenAI(texts, options);
      case 'ollama':
        return this.callOllama(texts, options);
      case 'local':
        return this.callLocal(texts, options);
      default:
        throw new Error(`Unsupported embedding provider: ${this.config.provider}`);
    }
  }

  /**
   * Call OpenAI Embedding API
   */
  private async callOpenAI(texts: string[], options?: EmbedOptions): Promise<EmbedResult[]> {
    // Use model from options, or config model (not hardcoded default)
    const model = options?.model || this.config.model;
    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    const apiKey = this.config.apiKey;

    if (!model) {
      console.error('[EmbeddingService] ✗ Embedding model not configured!');
      throw new Error('Embedding model is not configured');
    }

    logger.info('[EmbeddingService] callEmbeddingAPI called');
    logger.info('[EmbeddingService] API Key status:', apiKey ? 'configured' : 'not configured');
    logger.info('[EmbeddingService] Model:', model);
    logger.info('[EmbeddingService] Base URL:', baseUrl);
    logger.info('[EmbeddingService] Text count:', texts.length);

    if (!apiKey) {
      console.error('[EmbeddingService] ✗ API Key not configured!');
      throw new Error('OpenAI API key is required');
    }

    interface OpenAIEmbeddingRequest {
      model: string;
      input: string[];
      dimensions?: number;
    }
    const requestBody: OpenAIEmbeddingRequest = {
      model,
      input: texts,
    };

    // Models supporting dimensions parameter: OpenAI text-embedding-3 series, SiliconFlow Qwen3-Embedding series
    if (
      options?.dimensions &&
      (model.includes('text-embedding-3') || model.includes('Qwen3-Embedding'))
    ) {
      requestBody.dimensions = options.dimensions;
    }

    // Build correct URL, avoid duplicate paths
    let url = baseUrl;
    // Remove trailing slash
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
    // If URL already contains /embeddings, don't append again
    if (!url.endsWith('/embeddings')) {
      url = `${url}/embeddings`;
    }

    logger.info('[EmbeddingService] Request URL:', url);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[EmbeddingService] ✗ API request failed');
      console.error('[EmbeddingService] Status code:', response.status);
      console.error('[EmbeddingService] Response:', errorText);
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    logger.info('[EmbeddingService] ✓ API request succeeded');

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    return data.data.map((item) => ({
      embedding: item.embedding,
      model,
      tokenCount: data.usage?.total_tokens,
    }));
  }

  /**
   * Call Ollama Embedding API
   */
  private async callOllama(texts: string[], options?: EmbedOptions): Promise<EmbedResult[]> {
    const model = options?.model || this.config.model;
    let baseUrl = this.config.baseUrl || 'http://localhost:11434';

    // Remove trailing slash
    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1);
    }

    const results: EmbedResult[] = [];

    logger.info('[EmbeddingService] Ollama API call');
    logger.info('[EmbeddingService] Base URL:', baseUrl);
    logger.info('[EmbeddingService] Model:', model);

    // Ollama doesn't support batching, need to request one by one
    for (const text of texts) {
      const url = `${baseUrl}/api/embeddings`;
      logger.info('[EmbeddingService] Request URL:', url);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;
      results.push({
        embedding: data.embedding,
        model,
      });
    }

    return results;
  }

  /**
   * Local embedding (placeholder, can integrate transformers.js, etc.)
   */
  private async callLocal(_texts: string[], _options?: EmbedOptions): Promise<EmbedResult[]> {
    // Local embedding implementation
    // Can integrate @xenova/transformers for pure JS embedding
    throw new Error('Local embedding not implemented yet. Please use OpenAI or Ollama.');
  }

  /**
   * Generate cache key
   */
  private getCacheKey(text: string): string {
    const hash = this.simpleHash(text);
    return `${this.config.model}:${hash}`;
  }

  /**
   * Simple hash function
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Add to cache
   */
  private addToCache(key: string, embedding: number[]): void {
    // Simplified LRU implementation: clear half when exceeding max capacity
    if (this.cache.size >= this.cacheMaxSize) {
      const keysToDelete = Array.from(this.cache.keys()).slice(0, this.cacheMaxSize / 2);
      for (const k of keysToDelete) {
        this.cache.delete(k);
      }
    }
    this.cache.set(key, embedding);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Test connection
   */
  async testConnection(): Promise<{ success: boolean; message: string; dimensions?: number }> {
    try {
      const result = await this.embed('test connection');
      return {
        success: true,
        message: `Connection successful, vector dimensions: ${result.embedding.length}`,
        dimensions: result.embedding.length,
      };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Calculate cosine similarity
   */
  static cosineSimilarity(a: number[], b: number[]): number {
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
   * Calculate Euclidean distance
   */
  static euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) return Number.POSITIVE_INFINITY;

    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += Math.pow(a[i] - b[i], 2);
    }

    return Math.sqrt(sum);
  }
}
