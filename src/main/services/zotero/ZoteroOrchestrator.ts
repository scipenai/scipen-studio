/**
 * @file ZoteroOrchestrator — state machine driving the canonical bib index
 * @description Owns the cold-boot, refresh and degraded-state lifecycle.
 *              Consumes `ZoteroLocalApiClient` and `BetterBibTexClient`
 *              as opaque data sources, normalises their joint output
 *              into `ZoteroItemDTO`, then drops it into the index and
 *              broadcasts the resulting event.
 *
 *              D-1 surface is intentionally narrow: bootstrap + refresh
 *              + diagnostics. PDF / annotations live on this same
 *              orchestrator later (D-6) but the data flow is symmetric.
 *
 *              Status transitions:
 *                 idle → bootstrapping → ready
 *                            │                │
 *                            ▼                ▼
 *                       degraded ◄─────── syncing
 *                            │
 *                            ▼
 *                          error
 *
 *              `degraded` means we have *some* data (LocalApi up, BBT
 *              down → citation keys fall back to 8-char itemKeys).
 *              `error` means we have *no* usable data.
 */

import type { ZoteroItemDTO } from '../../../../shared/types/zotero';
import type {
  BibStatus,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
} from '../../../../shared/types/zotero-events';
import { createLogger } from '../LoggerService';
import { BetterBibTexClient, getBetterBibTexClient } from './BetterBibTexClient';
import { ZoteroLocalApiClient, getZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { ZoteroEventBus, getZoteroEventBus } from './ZoteroEventBus';
import { ZoteroIndex } from './ZoteroIndex';

const logger = createLogger('ZoteroOrchestrator');

/** Cooldown between successive refreshes; protects BBT from focus-spam. */
const REFRESH_COOLDOWN_MS = 1500;

export interface OrchestratorDeps {
  localApi?: ZoteroLocalApiClient;
  bbt?: BetterBibTexClient;
  bus?: ZoteroEventBus;
  index?: ZoteroIndex;
  /** Clock indirection for tests; defaults to Date.now. */
  now?: () => number;
}

interface SourceProbe {
  ok: boolean;
  error?: string;
}

export class ZoteroOrchestrator {
  private readonly localApi: ZoteroLocalApiClient;
  private readonly bbt: BetterBibTexClient;
  private readonly bus: ZoteroEventBus;
  private readonly index: ZoteroIndex;
  private readonly now: () => number;

  private status: BibStatus = 'idle';
  private detail?: string;
  private lastSyncedAt?: string;
  private localApiProbe: SourceProbe = { ok: false };
  private bbtProbe: SourceProbe = { ok: false };
  private inFlight: Promise<RefreshResultDTO> | null = null;
  private lastAttemptAt = 0;

  constructor(deps: OrchestratorDeps = {}) {
    this.localApi = deps.localApi ?? getZoteroLocalApiClient();
    this.bbt = deps.bbt ?? getBetterBibTexClient();
    this.bus = deps.bus ?? getZoteroEventBus();
    this.index = deps.index ?? new ZoteroIndex();
    this.now = deps.now ?? Date.now;
  }

  // ============================================================
  // Public API (orchestrator surface)
  // ============================================================

  getIndex(): ZoteroIndex {
    return this.index;
  }

  /**
   * Initial cold boot. Idempotent: if already running, returns the same
   * promise. If already in `ready`, no-ops.
   */
  async bootstrap(): Promise<RefreshResultDTO> {
    if (this.status === 'ready') {
      return { triggered: false, status: 'ready' };
    }
    return this.runRefresh('bootstrapping');
  }

  /**
   * Manual / focus-triggered refresh. Honors a cooldown to dampen the
   * `window.on('focus')` torrent users generate by alt-tabbing.
   */
  async refresh(reason: 'focus' | 'manual' | 'error-recovery' = 'manual'): Promise<RefreshResultDTO> {
    const elapsed = this.now() - this.lastAttemptAt;
    if (this.inFlight) {
      return this.inFlight;
    }
    if (elapsed < REFRESH_COOLDOWN_MS && this.status !== 'error') {
      return { triggered: false, status: this.status, detail: 'cooldown' };
    }
    this.bus.emit({ kind: 'bib:invalidated', reason });
    return this.runRefresh('syncing');
  }

  getDiagnostics(): ZoteroDiagnosticsDTO {
    return {
      status: this.status,
      lastSyncedAt: this.lastSyncedAt,
      sources: {
        localApi: { ...this.localApiProbe },
        betterBibTex: { ...this.bbtProbe },
      },
      itemCount: this.index.size(),
      etag: this.index.getEtag(),
      detail: this.detail,
    };
  }

  // ============================================================
  // Refresh pipeline
  // ============================================================

  private async runRefresh(initialStatus: BibStatus): Promise<RefreshResultDTO> {
    const inFlight = this.doRefresh(initialStatus);
    this.inFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async doRefresh(initialStatus: BibStatus): Promise<RefreshResultDTO> {
    this.lastAttemptAt = this.now();
    this.transition(initialStatus);

    // Probe + fetch in parallel. Both legs handle their own errors so we
    // can tell apart "LocalApi down" from "BBT down" downstream.
    const [localApiResult, bbtHealthResult] = await Promise.all([
      this.fetchLocalApi(),
      this.fetchBbtHealth(),
    ]);

    if (!localApiResult.ok) {
      // LocalApi is the source of metadata; without it we have nothing
      // useful. Don't clear the existing index — keep stale data so the
      // editor stays warm; just flip status.
      this.localApiProbe = { ok: false, error: localApiResult.error };
      this.bbtProbe = bbtHealthResult.ok
        ? { ok: true }
        : { ok: false, error: bbtHealthResult.error };
      this.transition('error', localApiResult.error);
      return { triggered: true, status: 'error', detail: localApiResult.error };
    }

    this.localApiProbe = { ok: true };
    this.bbtProbe = bbtHealthResult.ok
      ? { ok: true }
      : { ok: false, error: bbtHealthResult.error };

    // citation key 由 LocalApi 直接从 data.citationKey 注入,无需 BBT 合并。
    // mergeBbtIntoItems 仍 export 作为可测试纯函数 + 将来 opt-in reconcile 工具。
    const items = localApiResult.items;

    // First-fill vs incremental:首次 cold boot 时 index 为空 → 走 hydrate,
    // 广播 bib:initial 让 renderer 整库 rehydrate。后续 refresh(window focus
    // 或 manual)走 diff + applyPatch,只广播变化的 bib:patch;无变化时退化
    // 为 bib:status 让 renderer 撤掉 "syncing" 旋转。
    const isFirstFill = this.index.size() === 0;
    const nextStatus: BibStatus = bbtHealthResult.ok ? 'ready' : 'degraded';

    if (isFirstFill) {
      this.index.hydrate(items, nextStatus);
      this.bus.emit({ kind: 'bib:initial', snapshot: this.index.buildSnapshot() });
    } else {
      const { upserts, deletes } = diffAgainstIndex(this.index, items);
      const patch = this.index.applyPatch(upserts, deletes, nextStatus);
      if (patch.upserts.length > 0 || patch.deletes.length > 0) {
        this.bus.emit({
          kind: 'bib:patch',
          upserts: patch.upserts,
          deletes: patch.deletes,
          etag: patch.etag,
          status: nextStatus,
        });
      } else {
        // 内容无变化,不发 bib:patch;状态回 ready 由下面的 transition() 统一 emit。
      }
    }

    this.lastSyncedAt = new Date(this.now()).toISOString();
    this.transition(nextStatus, bbtHealthResult.ok ? undefined : 'BBT unavailable');
    return { triggered: true, status: nextStatus };
  }

  private async fetchLocalApi(): Promise<
    { ok: true; items: ZoteroItemDTO[] } | { ok: false; error: string }
  > {
    try {
      const ping = await this.localApi.ping();
      if (!ping.ok) {
        return { ok: false, error: ping.error ?? 'Zotero Local API unreachable' };
      }
      const items = await this.localApi.getAllItems();
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * BBT 健康度信号 —— citation key 由 LocalApi 直接从 `data.citationKey`
   * (BBT 7+ 注入到 Zotero data schema)拿,无需 RPC。BBT down 仅影响
   * status(ready ↔ degraded),不影响数据可用性。
   */
  private async fetchBbtHealth(): Promise<{ ok: boolean; error?: string }> {
    try {
      const ping = await this.bbt.ping();
      if (!ping.ok) {
        return { ok: false, error: ping.error ?? 'Better BibTeX RPC unreachable' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Status 单一通路 —— 任何 status 变化都从这里 emit `bib:status` 到 bus,
   * renderer mirror 据此 bumpSnapshot,UI(StatusBadge spinner 等)随之同步。
   *
   * 之前 transition 只改本地,doRefresh 末尾才手动 emit `bib:status(ready)` —
   * 导致 syncing/bootstrapping 中间态对 renderer 完全不可见,StatusBar 永远停
   * 在 ready,"立即刷新"看起来没反应。统一到 transition 之后,所有调用方都
   * 不用再单独 emit;`bib:patch` / `bib:initial` 自带 status,mirror 端去重处理。
   */
  private transition(next: BibStatus, detail?: string): void {
    if (this.status === next && this.detail === detail) return;
    logger.info('Status transition', { from: this.status, to: next, detail });
    this.status = next;
    this.detail = detail;
    this.index.setStatus(next);
    this.bus.emit({ kind: 'bib:status', status: next, detail });
  }
}

// ============================================================
// Pure helpers (exported for testing)
// ============================================================

export function mergeBbtIntoItems(
  items: ZoteroItemDTO[],
  keysByItemKey: Map<string, string>
): ZoteroItemDTO[] {
  if (keysByItemKey.size === 0) return items;
  return items.map((item) => {
    const ck = keysByItemKey.get(item.itemKey);
    return ck ? { ...item, citationKey: ck } : item;
  });
}

export function diffAgainstIndex(
  index: ZoteroIndex,
  next: ZoteroItemDTO[]
): { upserts: ZoteroItemDTO[]; deletes: string[] } {
  const nextKeys = new Set<string>();
  const upserts: ZoteroItemDTO[] = [];

  for (const item of next) {
    nextKeys.add(item.itemKey);
    const prior = index.getByItemKey(item.itemKey);
    if (!prior || !shallowEqualItem(prior, item)) {
      upserts.push(item);
    }
  }

  const deletes: string[] = [];
  for (const prior of index.values()) {
    if (!nextKeys.has(prior.itemKey)) {
      deletes.push(prior.itemKey);
    }
  }
  return { upserts, deletes };
}

function shallowEqualItem(a: ZoteroItemDTO, b: ZoteroItemDTO): boolean {
  return (
    a.itemKey === b.itemKey &&
    a.itemType === b.itemType &&
    a.title === b.title &&
    a.creatorsLabel === b.creatorsLabel &&
    a.year === b.year &&
    a.citationKey === b.citationKey &&
    a.citation === b.citation &&
    a.bib === b.bib &&
    a.abstractNote === b.abstractNote
  );
}

let singleton: ZoteroOrchestrator | null = null;

export function getZoteroOrchestrator(): ZoteroOrchestrator {
  if (!singleton) {
    singleton = new ZoteroOrchestrator();
  }
  return singleton;
}
