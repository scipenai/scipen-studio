/**
 * @file EmbeddingIndexService — M3 active literature recommendation's
 *   embedding index orchestrator (follows the ZoteroOrchestrator shape:
 *   lazy build + bus subscription for incremental + invalidation rebuild +
 *   query entry).
 *
 * Vector index + cosine all live in main (EmbeddingStore); renderer never
 * holds them. Indexing corpus = item-level "title + abstract" (SPECTER-style),
 * only embed items that have an abstract. Two invalidation guards:
 * (1) modelId (provider/model change -> full rebuild); (2) abstractHash
 * (abstract change -> re-embed single item).
 *
 * This file (batch 2) recommend does cosine top3 only; batch 4 inserts LLM
 * rerank between cosine and return.
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
import { EmbeddingAuthError, EmbeddingClient, type EmbeddingClientConfig } from './EmbeddingClient';
import { EmbeddingStore, l2normalize } from './EmbeddingStore';
import { rerankCandidates, type RerankCandidate } from './EmbeddingRerank';
import { type ZoteroEventBus, getZoteroEventBus } from './ZoteroEventBus';
import type { ZoteroIndex } from './ZoteroIndex';
import { getZoteroOrchestrator } from './ZoteroOrchestrator';
import { aiService } from '../AIService';
import type { IAIService } from '../interfaces/IAIService';

const logger = createLogger('EmbeddingIndexService');

/** Cosine recall pool size (batch 4 rerank narrows to top3; batch 2 takes the first 3 directly). */
export const RECALL_POOL_SIZE = 15;
/** Number of recommendations returned to the user. */
export const RECOMMEND_TOP_K = 3;
/** Incremental flush debounce — avoid disk write on every upsert. */
const FLUSH_DEBOUNCE_MS = 5000;
/** Delay build after bib:initial (5k full library) to avoid bootstrap + BibTexSync peak. */
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
  /** Read provider / key / toggle; defaults to ConfigManager + keychain. */
  loadConfig?: () => ResolvedConfig;
  clientFactory?: (cfg: EmbeddingClientConfig) => EmbeddingClient;
  /** Chat model (reused for rerank); defaults to main singleton. */
  ai?: IAIService;
  /** Status change callback (batch 3 hooks webContents.send to broadcast progress). */
  onStatus?: (status: EmbeddingIndexStatusDTO) => void;
  now?: () => number;
  flushDebounceMs?: number;
  buildInitialDelayMs?: number;
}

function defaultLoadConfig(): ResolvedConfig {
  return {
    provider: configManager.get<ZoteroEmbeddingProvider>(
      ConfigKeys.ZoteroEmbeddingProvider,
      'zhipu'
    ),
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
  // Public API
  // ============================================================

  /** Set status broadcast callback (main hooks webContents.send, injected after singleton creation). */
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

  /** Subscribe to bib events for incremental updates. Re-entrant. */
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
   * Lazy build entry (called when settings enable / on startup / when key
   * is configured). Idempotent: while building, reuse the same promise;
   * if already ready and modelId unchanged, return immediately.
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

  /** provider / key change / manual rebuild: drop old client + index, force rebuild. */
  invalidate(reason: 'provider-change' | 'key-change' | 'manual'): void {
    logger.info('invalidate', { reason });
    this.client = null;
    this.store.clear();
    this.embedded = 0;
    // Critical: after clearing, we must invalidate ensureBuilt's "ready and
    // modelId unchanged -> early return" guard, otherwise store is empty but
    // the guard still thinks ready -> build() is skipped -> index stuck at 0.
    // Transition to building to express "rebuilding" and let renderer observe
    // a building->ready flip.
    this.setState('building');
    void this.ensureBuilt();
  }

  /**
   * Active recommendation query. Index not ready -> returns empty (with
   * current state for UI to surface). Cosine recall top15 -> LLM rerank
   * top3; falls back to pure cosine top3 if rerank unavailable.
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
      // Single full-library score pass: top3 takes the prefix, @cite rerank
      // consumes the full sequence — avoid a second scan.
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
          .map((r) =>
            this.toResultItem({ itemKey: r.itemKey, score: byKey.get(r.itemKey) ?? 0 }, r.reason)
          );
        logger.info('recommend result', { items: items.length, path: 'reranked' });
        return { items, paragraphHash, scores };
      }

      // Degraded path: distinguish "not configured" (cosine-only) from
      // "configured but busy/failed" (no-rerank).
      const degraded = this.ai.isConfigured() ? 'no-rerank' : 'cosine-only';
      const items = hits.slice(0, RECOMMEND_TOP_K).map((h) => this.toResultItem(h));
      logger.info('recommend result', { items: items.length, path: degraded });
      return { items, paragraphHash, degraded, scores };
    } catch (err) {
      logger.warn('recommend failed', { error: String(err) });
      if (err instanceof EmbeddingAuthError) this.setState('error', 'API key invalid');
      // On failure, omit scores so renderer keeps the previous cache and the
      // @cite dropdown doesn't suddenly lose its order.
      return { items: [], paragraphHash };
    }
  }

  // ============================================================
  // Build / incremental
  // ============================================================

  private async build(client: EmbeddingClient): Promise<void> {
    this.setState('building');
    this.embedded = 0;
    try {
      await this.store.loadFromDisk(client.modelId);
      this.store.setModelId(client.modelId); // Bind explicitly, do not rely on loadFromDisk side effect
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
      const msg =
        err instanceof EmbeddingAuthError
          ? 'API key invalid'
          : 'Build failed (network or service error)';
      this.setState('error', msg);
    }
  }

  private async applyIncremental(upserts: { itemKey: string }[], deletes: string[]): Promise<void> {
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

  /** From ZoteroIndex, pull items with abstracts, build "title + abstract" corpus + hash. */
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

  /** Map full-library scores into citationKey space (filter out non-citable items
   *  without BBT key), for @cite reranking. Input is already descending; filter
   *  preserves order. */
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
