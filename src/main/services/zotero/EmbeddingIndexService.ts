/**
 * @file EmbeddingIndexService —— M3 主动文献推荐的 embedding 索引编排(照
 *   ZoteroOrchestrator 形态:lazy 建库 + 订阅 bus 增量 + 失效重建 + 查询入口)。
 *
 * 向量索引 + cosine 都在 main(EmbeddingStore),renderer 永不持有。建库语料 =
 * 条目级「title + abstract」(SPECTER 式),只对有摘要的条目 embed。失效守卫
 * 两层:① modelId(provider/model 变 → 整库重建);② abstractHash(摘要变 →
 * 单条重 embed)。
 *
 * 本文件(批2)recommend 只做 cosine top3;批4 在 cosine 与返回之间插 LLM rerank。
 */

import type { ZoteroEmbeddingProvider } from '../../../../shared/types/zotero';
import type {
  EmbeddingIndexState,
  EmbeddingIndexStatusDTO,
  RecommendRequestDTO,
  ZoteroEmbeddingResultDTO,
  ZoteroEmbeddingResultItemDTO,
} from '../../../../shared/types/zotero-embedding';
import { hashParagraph } from '../../../../shared/utils/sectionExtract';
import { ConfigKeys } from '../../../../shared/types/config-keys';
import { configManager } from '../ConfigManager';
import { getZoteroEmbeddingApiKey } from '../SecureStorageService';
import { createLogger } from '../LoggerService';
import {
  EmbeddingAuthError,
  EmbeddingClient,
  type EmbeddingClientConfig,
} from './EmbeddingClient';
import { EmbeddingStore, l2normalize } from './EmbeddingStore';
import { rerankCandidates, type RerankCandidate } from './EmbeddingRerank';
import { ZoteroEventBus, getZoteroEventBus } from './ZoteroEventBus';
import { ZoteroIndex } from './ZoteroIndex';
import { getZoteroOrchestrator } from './ZoteroOrchestrator';
import { aiService } from '../AIService';
import type { IAIService } from '../interfaces/IAIService';

const logger = createLogger('EmbeddingIndexService');

/** cosine 粗召池大小(批4 rerank 从中精排 top3;批2 直接取前 3)。 */
export const RECALL_POOL_SIZE = 15;
/** 返回给用户的推荐条数。 */
export const RECOMMEND_TOP_K = 3;
/** 增量写盘 debounce,避免每条 upsert 都落盘。 */
const FLUSH_DEBOUNCE_MS = 5000;
/** bib:initial(全库 5k)后延迟建库,避开 bootstrap + BibTexSync 高峰。 */
const BUILD_INITIAL_DELAY_MS = 2000;

interface ResolvedConfig {
  provider: ZoteroEmbeddingProvider;
  apiKey: string | null;
  enabled: boolean;
}

export interface EmbeddingIndexDeps {
  index?: ZoteroIndex;
  bus?: ZoteroEventBus;
  store?: EmbeddingStore;
  /** 读取 provider / key / 开关;默认读 ConfigManager + keychain。 */
  loadConfig?: () => ResolvedConfig;
  clientFactory?: (cfg: EmbeddingClientConfig) => EmbeddingClient;
  /** 聊天模型(rerank 复用);默认 main 单例。 */
  ai?: IAIService;
  /** 状态变化回调(批3 接 webContents.send 广播进度)。 */
  onStatus?: (status: EmbeddingIndexStatusDTO) => void;
  now?: () => number;
  flushDebounceMs?: number;
  buildInitialDelayMs?: number;
}

function defaultLoadConfig(): ResolvedConfig {
  return {
    provider: configManager.get<ZoteroEmbeddingProvider>(ConfigKeys.ZoteroEmbeddingProvider, 'zhipu'),
    apiKey: getZoteroEmbeddingApiKey(),
    enabled: configManager.get<boolean>(ConfigKeys.ZoteroActiveRecommendation, false),
  };
}

export class EmbeddingIndexService {
  private readonly index: ZoteroIndex;
  private readonly bus: ZoteroEventBus;
  private readonly store: EmbeddingStore;
  private readonly loadConfig: () => ResolvedConfig;
  private readonly clientFactory: (cfg: EmbeddingClientConfig) => EmbeddingClient;
  private readonly ai: IAIService;
  private onStatus?: (status: EmbeddingIndexStatusDTO) => void;
  private readonly now: () => number;
  private readonly flushDebounceMs: number;
  private readonly buildInitialDelayMs: number;

  private state: EmbeddingIndexState = 'disabled';
  private errorMessage?: string;
  private embedded = 0;
  private total = 0;

  private client: EmbeddingClient | null = null;
  private buildInFlight: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private initialDelayTimer: NodeJS.Timeout | null = null;
  private unsubBus: (() => void) | null = null;

  constructor(deps: EmbeddingIndexDeps = {}) {
    this.index = deps.index ?? getZoteroOrchestrator().getIndex();
    this.bus = deps.bus ?? getZoteroEventBus();
    this.store = deps.store ?? new EmbeddingStore();
    this.loadConfig = deps.loadConfig ?? defaultLoadConfig;
    this.clientFactory = deps.clientFactory ?? ((cfg) => new EmbeddingClient(cfg));
    this.ai = deps.ai ?? aiService;
    this.onStatus = deps.onStatus;
    this.now = deps.now ?? Date.now;
    this.flushDebounceMs = deps.flushDebounceMs ?? FLUSH_DEBOUNCE_MS;
    this.buildInitialDelayMs = deps.buildInitialDelayMs ?? BUILD_INITIAL_DELAY_MS;
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /** 设置状态广播回调(main 接 webContents.send,单例创建后注入)。 */
  setStatusListener(cb: (status: EmbeddingIndexStatusDTO) => void): void {
    this.onStatus = cb;
  }

  getStatus(): EmbeddingIndexStatusDTO {
    return {
      state: this.state,
      modelId: this.store.getModelId(),
      total: this.total,
      embedded: this.embedded,
      errorMessage: this.errorMessage,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** 订阅 bib 事件做增量。可重入。 */
  start(): void {
    if (this.unsubBus) return;
    this.unsubBus = this.bus.on((event) => {
      if (event.kind === 'bib:initial') {
        this.scheduleInitialBuild();
      } else if (event.kind === 'bib:patch') {
        void this.applyIncremental(event.upserts, event.deletes);
      }
    });
    logger.info('EmbeddingIndexService started');
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.initialDelayTimer) clearTimeout(this.initialDelayTimer);
    this.flushTimer = null;
    this.initialDelayTimer = null;
    this.unsubBus?.();
    this.unsubBus = null;
  }

  /**
   * Lazy 建库入口(settings 开启 / 启动 / key 配好时调)。幂等:building 中
   * 复用同一 promise;已 ready 且 modelId 未变直接返回。
   */
  async ensureBuilt(): Promise<void> {
    if (this.buildInFlight) return this.buildInFlight;
    const cfg = this.loadConfig();
    if (!cfg.enabled) {
      this.setState('disabled');
      return;
    }
    if (!cfg.apiKey) {
      this.setState('no-key');
      return;
    }
    const client = this.ensureClient(cfg);
    if (this.state === 'ready' && this.store.getModelId() === client.modelId) return;

    this.buildInFlight = this.build(client).finally(() => {
      this.buildInFlight = null;
    });
    return this.buildInFlight;
  }

  /** provider / key 变更 / 手动重建:丢弃旧 client + 索引,强制重建。 */
  invalidate(reason: 'provider-change' | 'key-change' | 'manual'): void {
    logger.info('invalidate', { reason });
    this.client = null;
    this.store.clear();
    this.embedded = 0;
    // 关键:清空后必须让 ensureBuilt 的「ready 且 modelId 未变 → 早退」守卫失效,
    // 否则 store 已空但守卫仍认为 ready,build() 被跳过 → 库永久停在 0 篇。
    // 转 building 表达「正在重建」,且让 renderer 收到 building→ready 翻转。
    this.setState('building');
    void this.ensureBuilt();
  }

  /**
   * 主动推荐查询。索引未 ready → 返回空(带当前 state 供 UI 提示)。
   * cosine 粗召 top15 → LLM rerank 精排 top3;rerank 不可用时降级纯 cosine top3。
   */
  async recommend(req: RecommendRequestDTO): Promise<ZoteroEmbeddingResultDTO> {
    const paragraphHash = hashParagraph(req.paragraph);
    logger.info('recommend enter', {
      state: this.state,
      storeSize: this.store.size(),
      total: this.total,
      paragraphChars: req.paragraph.length,
      lang: req.lang,
    });
    if (this.state !== 'ready' || !this.client) {
      logger.info('recommend skip: not ready', { state: this.state, hasClient: !!this.client });
      return { items: [], paragraphHash, scores: [] };
    }
    try {
      const { vector } = await this.client.embedOne(req.paragraph);
      // 一次全库打分:top3 取前缀,@cite 重排消费完整序——避免二次扫描。
      const allScored = this.store.scoreAll(l2normalize(vector));
      const scores = this.toCitationScores(allScored);
      const hits = allScored.slice(0, RECALL_POOL_SIZE);
      const candidates = hits.map((h) => this.toCandidate(h));
      logger.info('recommend scored', {
        scoredAll: allScored.length,
        withCitationKey: scores.length,
        pool: hits.length,
        topScore: allScored[0]?.score ?? null,
      });

      const reranked = await rerankCandidates(this.ai, req.paragraph, candidates, req.lang);
      if (reranked) {
        const byKey = new Map(hits.map((h) => [h.itemKey, h.score]));
        const items = reranked
          .slice(0, RECOMMEND_TOP_K)
          .map((r) => this.toResultItem({ itemKey: r.itemKey, score: byKey.get(r.itemKey) ?? 0 }, r.reason));
        logger.info('recommend result', { items: items.length, path: 'reranked' });
        return { items, paragraphHash, scores };
      }

      // 降级:区分「未配置」(cosine-only)与「配置了但忙/失败」(no-rerank)。
      const degraded = this.ai.isConfigured() ? 'no-rerank' : 'cosine-only';
      const items = hits.slice(0, RECOMMEND_TOP_K).map((h) => this.toResultItem(h));
      logger.info('recommend result', { items: items.length, path: degraded });
      return { items, paragraphHash, degraded, scores };
    } catch (err) {
      logger.warn('recommend failed', { error: String(err) });
      if (err instanceof EmbeddingAuthError) this.setState('error', 'API key 无效');
      // 失败不带 scores → renderer 保留上次缓存,@cite 下拉不瞬间失序。
      return { items: [], paragraphHash };
    }
  }

  // ============================================================
  // 建库 / 增量
  // ============================================================

  private async build(client: EmbeddingClient): Promise<void> {
    this.setState('building');
    this.embedded = 0;
    try {
      await this.store.loadFromDisk(client.modelId);
      this.store.setModelId(client.modelId); // 显式绑定,不依赖 loadFromDisk 副作用
      const items = this.collectCorpus();
      this.total = items.length;
      const pending = items.filter((it) => !this.store.has(it.itemKey, it.hash));
      this.embedded = this.store.size();

      if (pending.length > 0) {
        const result = await client.embedBatch(
          pending.map((p) => p.text),
          { onProgress: (done) => this.reportProgress(this.store.size() + done) }
        );
        pending.forEach((p, i) => {
          this.store.upsert(p.itemKey, p.hash, l2normalize(result.vectors[i]));
        });
        await this.store.flushToDisk();
      }
      this.embedded = this.store.size();
      this.setState('ready');
    } catch (err) {
      logger.warn('build failed', { error: String(err) });
      const msg = err instanceof EmbeddingAuthError ? 'API key 无效' : '建库失败(网络或服务异常)';
      this.setState('error', msg);
    }
  }

  private async applyIncremental(
    upserts: { itemKey: string }[],
    deletes: string[]
  ): Promise<void> {
    if (this.state !== 'ready' || !this.client) return;
    for (const key of deletes) this.store.remove(key);

    const pending = this.collectCorpus()
      .filter((c) => upserts.some((u) => u.itemKey === c.itemKey))
      .filter((c) => !this.store.has(c.itemKey, c.hash));

    if (pending.length > 0) {
      try {
        const result = await this.client.embedBatch(pending.map((p) => p.text));
        pending.forEach((p, i) => {
          this.store.upsert(p.itemKey, p.hash, l2normalize(result.vectors[i]));
        });
      } catch (err) {
        logger.warn('incremental embed failed', { error: String(err) });
      }
    }
    this.embedded = this.store.size();
    this.total = this.collectCorpus().length;
    this.scheduleFlush();
    this.emitStatus();
  }

  /** 从 ZoteroIndex 取有摘要的条目,组「title + abstract」语料 + hash。 */
  private collectCorpus(): Array<{ itemKey: string; text: string; hash: string }> {
    const out: Array<{ itemKey: string; text: string; hash: string }> = [];
    for (const item of this.index.values()) {
      const abstract = item.abstractNote?.trim();
      if (!abstract) continue;
      const text = `${item.title}\n${abstract}`;
      out.push({ itemKey: item.itemKey, text, hash: hashParagraph(text) });
    }
    return out;
  }

  private toResultItem(
    hit: { itemKey: string; score: number },
    reason?: string
  ): ZoteroEmbeddingResultItemDTO {
    const item = this.index.getByItemKey(hit.itemKey);
    return {
      itemKey: hit.itemKey,
      citationKey: item?.citationKey,
      title: item?.title ?? hit.itemKey,
      year: item?.year,
      score: hit.score,
      reason,
      reranked: reason !== undefined,
    };
  }

  private toCandidate(hit: { itemKey: string; score: number }): RerankCandidate {
    const item = this.index.getByItemKey(hit.itemKey);
    return {
      itemKey: hit.itemKey,
      citationKey: item?.citationKey,
      title: item?.title ?? hit.itemKey,
      abstract: item?.abstractNote,
      cosineScore: hit.score,
    };
  }

  /** 全库分映射到 citationKey 空间(过滤无 BBT key 的不可引用条目),供 @cite 重排。
   *  入参已降序,过滤保序。 */
  private toCitationScores(
    scored: Array<{ itemKey: string; score: number }>
  ): Array<{ citationKey: string; score: number }> {
    const out: Array<{ citationKey: string; score: number }> = [];
    for (const s of scored) {
      const ck = this.index.getByItemKey(s.itemKey)?.citationKey;
      if (ck) out.push({ citationKey: ck, score: s.score });
    }
    return out;
  }

  // ============================================================
  // helpers
  // ============================================================

  private ensureClient(cfg: ResolvedConfig): EmbeddingClient {
    const wantModel = this.clientFactory({ provider: cfg.provider, apiKey: cfg.apiKey ?? '' });
    if (!this.client || this.client.modelId !== wantModel.modelId) {
      this.client = wantModel;
    }
    return this.client;
  }

  private scheduleInitialBuild(): void {
    if (this.initialDelayTimer) clearTimeout(this.initialDelayTimer);
    this.initialDelayTimer = setTimeout(() => {
      this.initialDelayTimer = null;
      void this.ensureBuilt();
    }, this.buildInitialDelayMs);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.store.flushToDisk();
    }, this.flushDebounceMs);
  }

  private reportProgress(embedded: number): void {
    this.embedded = embedded;
    this.emitStatus();
  }

  private setState(state: EmbeddingIndexState, errorMessage?: string): void {
    this.state = state;
    this.errorMessage = errorMessage;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatus?.(this.getStatus());
  }
}

let singleton: EmbeddingIndexService | null = null;

export function getEmbeddingIndexService(): EmbeddingIndexService {
  if (!singleton) singleton = new EmbeddingIndexService();
  return singleton;
}

/** Tests only. */
export function __resetEmbeddingIndexSingleton(): void {
  singleton?.stop();
  singleton = null;
}
