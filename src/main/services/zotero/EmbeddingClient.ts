/**
 * @file EmbeddingClient — BYOK client for cloud embedding providers (Zhipu / Aliyun / OpenAI).
 *
 * All three are OpenAI-compatible `/embeddings`: request `{ input, model }`,
 * response `{ data: [{ embedding: number[] }] }`, auth `Authorization: Bearer <key>`.
 * The key is read by main from the keychain and passed into the constructor;
 * **renderer never sees plaintext**.
 *
 * Index build goes through `embedBatch` (per-provider batch limit + small
 * concurrency); queries go through `embedOne`. Single HTTP call 30s timeout
 * (AbortController), matching MinerUParseService.
 */

import type { ZoteroEmbeddingProvider } from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';

const logger = createLogger('EmbeddingClient');

/** Single HTTP timeout. Embedding request body is small; 30s covers network jitter. */
const HTTP_TIMEOUT_MS = 30_000;
/** Concurrent request count during index build (avoid bursting provider rate limits). */
const BUILD_CONCURRENCY = 3;

/** Endpoint + default model per provider. */
const PROVIDER_ENDPOINTS: Record<ZoteroEmbeddingProvider, { url: string; model: string }> = {
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', model: 'embedding-3' },
  aliyun: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    model: 'text-embedding-v3',
  },
  openai: { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
};

/** Max input items per request per provider (conservative, avoids exceeding provider caps). */
const PROVIDER_BATCH_LIMIT: Record<ZoteroEmbeddingProvider, number> = {
  zhipu: 64,
  aliyun: 10,
  openai: 256,
};

export interface EmbeddingClientConfig {
  provider: ZoteroEmbeddingProvider;
  apiKey: string;
  /** Override default model; empty falls back to provider default. */
  model?: string;
}

export interface EmbedResult {
  vectors: number[][];
  modelId: string;
  dim: number;
}

/** Thrown when the key is invalid (401/403); upper layers flip to error state and stop retrying. */
export class EmbeddingAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingAuthError';
  }
}

/** Resolve a provider's endpoint + model (model override takes precedence). Exported for unit tests. */
export function resolveEmbeddingEndpoint(
  provider: ZoteroEmbeddingProvider,
  model?: string
): { url: string; model: string } {
  const base = PROVIDER_ENDPOINTS[provider];
  return { url: base.url, model: model?.trim() || base.model };
}

/** Model tag (label for the vector invalidation guard): `provider:model`. Exported for unit tests. */
export function modelIdFor(provider: ZoteroEmbeddingProvider, model: string): string {
  return `${provider}:${model}`;
}

/** Split N items into batches of size. Exported for unit tests. */
export function chunkBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class EmbeddingClient {
  private readonly url: string;
  private readonly model: string;
  readonly modelId: string;
  private readonly batchLimit: number;

  constructor(private readonly cfg: EmbeddingClientConfig) {
    const { url, model } = resolveEmbeddingEndpoint(cfg.provider, cfg.model);
    this.url = url;
    this.model = model;
    this.modelId = modelIdFor(cfg.provider, model);
    this.batchLimit = PROVIDER_BATCH_LIMIT[cfg.provider];
  }

  /** Single-item embedding (used for queries). Returns vector + modelId. */
  async embedOne(
    text: string,
    signal?: AbortSignal
  ): Promise<{ vector: number[]; modelId: string }> {
    const vectors = await this.callEmbeddings([text], signal);
    return { vector: vectors[0], modelId: this.modelId };
  }

  /**
   * Batch embedding (used to build the index). Splits by provider batch limit,
   * runs each window with small concurrency, preserves input/output order.
   * `onProgress` is invoked per completed batch with the running total.
   */
  async embedBatch(
    texts: string[],
    opts?: { signal?: AbortSignal; onProgress?: (done: number) => void }
  ): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], modelId: this.modelId, dim: 0 };

    const batches = chunkBatches(texts, this.batchLimit);
    const results: number[][][] = new Array(batches.length);
    let done = 0;

    // Slide a window of BUILD_CONCURRENCY to avoid saturating the rate limit at once.
    for (let i = 0; i < batches.length; i += BUILD_CONCURRENCY) {
      const window = batches.slice(i, i + BUILD_CONCURRENCY);
      await Promise.all(
        window.map(async (batch, j) => {
          const vecs = await this.callEmbeddings(batch, opts?.signal);
          results[i + j] = vecs;
          done += vecs.length;
          opts?.onProgress?.(done);
        })
      );
    }

    const vectors = results.flat();
    return { vectors, modelId: this.modelId, dim: vectors[0]?.length ?? 0 };
  }

  /** Actual HTTP call. OpenAI-compatible `{input, model}` -> `{data:[{embedding}]}`. */
  private async callEmbeddings(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const onParentAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        if (resp.status === 401 || resp.status === 403) {
          throw new EmbeddingAuthError(`embedding auth failed (${resp.status})`);
        }
        throw new Error(`embedding HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }

      const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
      const data = json.data ?? [];
      if (data.length !== input.length) {
        throw new Error(`embedding count mismatch: got ${data.length}, want ${input.length}`);
      }
      return data.map((d, i) => {
        if (!Array.isArray(d.embedding)) throw new Error(`embedding[${i}] missing vector`);
        return d.embedding;
      });
    } catch (err) {
      if (err instanceof EmbeddingAuthError) throw err;
      logger.warn('embeddings call failed', { provider: this.cfg.provider, error: String(err) });
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }
}
