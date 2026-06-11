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
import { type BetterBibTexClient, getBetterBibTexClient } from './BetterBibTexClient';
import { type ZoteroLocalApiClient, getZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { type ZoteroEventBus, getZoteroEventBus } from './ZoteroEventBus';
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
  async refresh(
    reason: 'focus' | 'manual' | 'error-recovery' = 'manual'
  ): Promise<RefreshResultDTO> {
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
    this.bbtProbe = bbtHealthResult.ok ? { ok: true } : { ok: false, error: bbtHealthResult.error };

    // citation key is injected directly by LocalApi from data.citationKey; no BBT merge needed.
    // mergeBbtIntoItems is still exported as a testable pure function + future opt-in reconcile tool.
    const items = localApiResult.items;

    // First-fill vs incremental: on cold boot the index is empty → hydrate,
    // broadcast bib:initial so renderer rehydrates the whole library. Subsequent
    // refreshes (window focus or manual) go through diff + applyPatch and only
    // broadcast changed bib:patch; when nothing changed, fall back to bib:status
    // so renderer drops the "syncing" spinner.
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
        // No content change; don't emit bib:patch. The status flip back to ready is emitted by the transition() call below.
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
   * BBT health signal — citation keys are read by LocalApi directly from
   * `data.citationKey` (BBT 7+ injects them into the Zotero data schema),
   * no RPC needed. BBT being down only affects status (ready ↔ degraded);
   * data availability is unaffected.
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
   * Single status channel — every status change emits `bib:status` to the
   * bus from here, and the renderer mirror bumps its snapshot so UI
   * (StatusBadge spinner, etc.) stays in sync.
   *
   * Previously transition() only mutated local state and doRefresh
   * manually emitted `bib:status(ready)` at the end — so syncing/
   * bootstrapping intermediate states were invisible to the renderer and
   * the StatusBar was stuck on ready, making "refresh now" look like a
   * no-op. After centralising on transition, no caller emits status
   * separately; `bib:patch` / `bib:initial` carry status, and the mirror
   * dedupes.
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
