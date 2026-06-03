/**
 * @file EmbeddingClient —— 云 embedding 提供商(智谱/阿里/openai)的 BYOK 客户端。
 *
 * 三家都是 OpenAI 兼容的 `/embeddings` 形态:请求 `{ input, model }`、响应
 * `{ data: [{ embedding: number[] }] }`,鉴权 `Authorization: Bearer <key>`。
 * key 由 main 从 keychain 读出后传入构造,**renderer 永不见明文**。
 *
 * 建库走 `embedBatch`(按 provider 批上限分批 + 小并发),查询走 `embedOne`。
 * 单次 HTTP 30s 超时(AbortController),照 MinerUParseService 形态。
 */

import type { ZoteroEmbeddingProvider } from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';

const logger = createLogger('EmbeddingClient');

/** 单次 HTTP 超时。embedding 请求体小,30s 足够覆盖网络抖动。 */
const HTTP_TIMEOUT_MS = 30_000;
/** 建库时并发请求数(避免突发打满 provider 限流)。 */
const BUILD_CONCURRENCY = 3;

/** 各 provider 的端点 + 默认模型。 */
const PROVIDER_ENDPOINTS: Record<ZoteroEmbeddingProvider, { url: string; model: string }> = {
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', model: 'embedding-3' },
  aliyun: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    model: 'text-embedding-v3',
  },
  openai: { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
};

/** 各 provider 单次请求的最大输入条数(保守取值,避免超 provider 上限）。 */
const PROVIDER_BATCH_LIMIT: Record<ZoteroEmbeddingProvider, number> = {
  zhipu: 64,
  aliyun: 10,
  openai: 256,
};

export interface EmbeddingClientConfig {
  provider: ZoteroEmbeddingProvider;
  apiKey: string;
  /** 覆盖默认模型;留空用 provider 默认。 */
  model?: string;
}

export interface EmbedResult {
  vectors: number[][];
  modelId: string;
  dim: number;
}

/** key 无效(401/403)时抛此错,上层据此转 error 态并停止重试。 */
export class EmbeddingAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingAuthError';
  }
}

/** 解析 provider 的端点 + 模型(model 覆盖优先)。导出供单测。 */
export function resolveEmbeddingEndpoint(
  provider: ZoteroEmbeddingProvider,
  model?: string
): { url: string; model: string } {
  const base = PROVIDER_ENDPOINTS[provider];
  return { url: base.url, model: model?.trim() || base.model };
}

/** 模型标识(向量失效守卫的标签):`provider:model`。导出供单测。 */
export function modelIdFor(provider: ZoteroEmbeddingProvider, model: string): string {
  return `${provider}:${model}`;
}

/** 把 N 个元素按 size 切成多个批。导出供单测。 */
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

  /** 单条 embedding(查询用)。返回向量 + modelId。 */
  async embedOne(
    text: string,
    signal?: AbortSignal
  ): Promise<{ vector: number[]; modelId: string }> {
    const vectors = await this.callEmbeddings([text], signal);
    return { vector: vectors[0], modelId: this.modelId };
  }

  /**
   * 批量 embedding(建库用)。按 provider 批上限分批,每批小并发跑,
   * 保持输入顺序与输出顺序一致。`onProgress` 每完成一批回调累计数。
   */
  async embedBatch(
    texts: string[],
    opts?: { signal?: AbortSignal; onProgress?: (done: number) => void }
  ): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], modelId: this.modelId, dim: 0 };

    const batches = chunkBatches(texts, this.batchLimit);
    const results: number[][][] = new Array(batches.length);
    let done = 0;

    // 以 BUILD_CONCURRENCY 为窗口滑动执行,避免一次性打满限流。
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

  /** 实际 HTTP 调用。OpenAI 兼容 `{input, model}` → `{data:[{embedding}]}`。 */
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
