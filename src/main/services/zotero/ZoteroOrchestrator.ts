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

import type {
  ZoteroCitationKeyOrigin,
  ZoteroDataSource,
  ZoteroItemDTO,
} from '../../../../shared/types/zotero';
import type {
  BibStatus,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
} from '../../../../shared/types/zotero-events';
import { createLogger } from '../LoggerService';
import { type BetterBibTexClient, getBetterBibTexClient } from './BetterBibTexClient';
import { type ZoteroLocalApiClient, getZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { ZoteroWebApiClient } from './ZoteroWebApiClient';
import { type CitationKeyStore, getCitationKeyStore } from './CitationKeyStore';
import { mintCitationKey } from './citationKeyMinter';
import { type ZoteroEventBus, getZoteroEventBus } from './ZoteroEventBus';
import { ZoteroIndex } from './ZoteroIndex';
import { configManager } from '../ConfigManager';
import { ConfigKeys } from '../../../../shared/types/config-keys';
import { getZoteroWebApiKey, secureHas, SecureStorageKeys } from '../SecureStorageService';
import type { ZoteroDataSource as ZoteroDataSourceFacade } from './ZoteroDataSource';
import { ZoteroLocalDataSource } from './ZoteroLocalDataSource';
import { ZoteroWebDataSource } from './ZoteroWebDataSource';
import { type ZoteroFullTextService, getZoteroFullTextService } from './ZoteroFullTextService';

const logger = createLogger('ZoteroOrchestrator');

/**
 * Refresh cooldown — protects sources from focus-spam. Web mode uses a
 * longer cooldown because api.zotero.org rate-limits at ~30 req/min per
 * key and BBT-style focus torrents would burn budget fast.
 */
const REFRESH_COOLDOWN_LOCAL_MS = 1500;
const REFRESH_COOLDOWN_WEB_MS = 5000;

/** Bundle of runtime state the orchestrator needs at refresh time. */
export interface OrchestratorSettingsSnapshot {
  dataSource: ZoteroDataSource;
  webApiUserId: string;
  hasWebApiKey: boolean;
}

export interface OrchestratorDeps {
  localApi?: ZoteroLocalApiClient;
  bbt?: BetterBibTexClient;
  /**
   * Composed into the local ZoteroDataSource so `getActiveSource().getFullText()`
   * dispatches to pdf-parse / MinerU exactly like the old direct-service path.
   */
  fullTextService?: ZoteroFullTextService;
  bus?: ZoteroEventBus;
  index?: ZoteroIndex;
  /**
   * Optional factory that returns a fully-configured ZoteroWebApiClient
   * (userId + apiKey resolved from secure storage) OR null when
   * credentials are missing. Called lazily each refresh so cred changes
   * apply without orchestrator state invalidation. Absent in local-only
   * deployments; A6's IPC wiring injects the production factory.
   */
  getWebApiClient?: () => ZoteroWebApiClient | null;
  /**
   * Persistent cite-key memory. Required for web mode's 3-layer citation
   * key normalization; absent in local-only tests (defaulting is safe
   * because local path never touches it).
   */
  keyStore?: CitationKeyStore;
  /** Read current data-source + web credentials shape. Local mode = default. */
  getSettings?: () => OrchestratorSettingsSnapshot;
  /** Clock indirection for tests; defaults to Date.now. */
  now?: () => number;
}

interface SourceProbe {
  ok: boolean;
  error?: string;
  detail?: string;
}

export class ZoteroOrchestrator {
  private readonly localApi: ZoteroLocalApiClient;
  private readonly bbt: BetterBibTexClient;
  private readonly bus: ZoteroEventBus;
  private readonly index: ZoteroIndex;
  private readonly now: () => number;
  private readonly getWebApiClient: () => ZoteroWebApiClient | null;
  private readonly keyStore: CitationKeyStore | null;
  private readonly getSettings: () => OrchestratorSettingsSnapshot;
  /**
   * Local backend adapter — composed once at construct time. Local clients
   * (LocalApi + BBT + FullTextService) are all long-lived singletons, so a
   * single facade instance suffices; no need to rebuild across refreshes.
   */
  private readonly localSource: ZoteroLocalDataSource;
  /**
   * Web backend adapter — rebuilt when the underlying WebApiClient identity
   * changes (i.e. credentials rotated). Null when not configured.
   */
  private cachedWebSource: { source: ZoteroWebDataSource; client: ZoteroWebApiClient } | null =
    null;

  private status: BibStatus = 'idle';
  private detail?: string;
  private lastSyncedAt?: string;
  private localApiProbe: SourceProbe = { ok: false };
  private bbtProbe: SourceProbe = { ok: false };
  private webApiProbe: SourceProbe = { ok: false };
  private inFlight: Promise<RefreshResultDTO> | null = null;
  private lastAttemptAt = 0;

  constructor(deps: OrchestratorDeps = {}) {
    this.localApi = deps.localApi ?? getZoteroLocalApiClient();
    this.bbt = deps.bbt ?? getBetterBibTexClient();
    const fullTextService = deps.fullTextService ?? getZoteroFullTextService();
    this.bus = deps.bus ?? getZoteroEventBus();
    this.index = deps.index ?? new ZoteroIndex();
    this.now = deps.now ?? Date.now;
    this.getWebApiClient = deps.getWebApiClient ?? (() => null);
    this.keyStore = deps.keyStore ?? null;
    this.getSettings =
      deps.getSettings ?? (() => ({ dataSource: 'local', webApiUserId: '', hasWebApiKey: false }));
    this.localSource = new ZoteroLocalDataSource({
      localApi: this.localApi,
      bbt: this.bbt,
      fullTextService,
    });
  }

  // ============================================================
  // Public API (orchestrator surface)
  // ============================================================

  getIndex(): ZoteroIndex {
    return this.index;
  }

  /**
   * Return the currently active data source facade — or null when web mode
   * is selected but credentials are missing. IPC handlers use this to run
   * mode-agnostic reads (`getItemAnnotations` / `getFullText` /
   * `getCslByCitationKey`) so they never need to branch on mode themselves.
   *
   * The web facade is memoized by the client's identity: rotating credentials
   * (which produces a new `ZoteroWebApiClient` instance from the injected
   * factory) transparently rebuilds the facade on the next call.
   *
   * Public entry point — reads current settings. Internal callers that need
   * a stable snapshot across an async operation (e.g. `doRefresh`) should
   * use `resolveActiveSource(dataSource)` with a pinned snapshot instead,
   * to avoid mode-flip races.
   */
  getActiveSource(): ZoteroDataSourceFacade | null {
    return this.resolveActiveSource(this.getSettings().dataSource);
  }

  /**
   * Pure resolver — accepts a caller-pinned `dataSource` snapshot. Same
   * memoization as `getActiveSource()` but never reads `this.getSettings()`
   * itself, so the caller controls the mode consistency for the duration
   * of its logical operation.
   */
  private resolveActiveSource(dataSource: ZoteroDataSource): ZoteroDataSourceFacade | null {
    if (dataSource === 'web') {
      const client = this.getWebApiClient();
      if (!client) {
        this.cachedWebSource = null;
        return null;
      }
      if (this.cachedWebSource?.client === client) {
        return this.cachedWebSource.source;
      }
      const source = new ZoteroWebDataSource({ client });
      this.cachedWebSource = { source, client };
      return source;
    }
    return this.localSource;
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
   * `window.on('focus')` torrent users generate by alt-tabbing. Cooldown
   * length varies by data source (web mode is longer because api.zotero.org
   * rate-limits at ~30 req/min per key).
   */
  async refresh(
    reason: 'focus' | 'manual' | 'error-recovery' = 'manual'
  ): Promise<RefreshResultDTO> {
    const elapsed = this.now() - this.lastAttemptAt;
    if (this.inFlight) {
      return this.inFlight;
    }
    const cooldown =
      this.getSettings().dataSource === 'web' ? REFRESH_COOLDOWN_WEB_MS : REFRESH_COOLDOWN_LOCAL_MS;
    if (elapsed < cooldown && this.status !== 'error') {
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
        web: { ...this.webApiProbe },
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

    // Pin settings snapshot once at start — every downstream branch
    // (fetchActiveSource / recordProbes / normalizeWebItems) uses the SAME
    // snapshot, so a mid-refresh mode-flip cannot mix "items from new source"
    // with "normalize for old mode". Without this pin, `fetchActiveSource`
    // used to call getSettings a second time internally, opening a race
    // window whenever the user toggled dataSource during an in-flight refresh.
    const settings = this.getSettings();
    const sourceResult = await this.fetchActiveSource(settings.dataSource);
    // BBT is only meaningful in local mode. Web mode skips its probe entirely
    // (no BBT running on api.zotero.org side) and citation keys go through
    // the 3-layer fallback below.
    const bbtHealthResult =
      settings.dataSource === 'local' ? await this.fetchBbtHealth() : { ok: true, skipped: true };

    if (!sourceResult.ok) {
      // Active source is the sole metadata provider; without it we have nothing
      // useful. Don't clear the existing index — keep stale data so the editor
      // stays warm; just flip status. Record per-source probes for diagnostics.
      this.recordProbes(settings.dataSource, sourceResult.error, bbtHealthResult);
      this.transition('error', sourceResult.error);
      return { triggered: true, status: 'error', detail: sourceResult.error };
    }
    this.recordProbes(settings.dataSource, undefined, bbtHealthResult);

    // Web mode: normalize citation keys via CitationKeyStore + minter fallback.
    // Local mode: LocalApi already fills item.citationKey from BBT-injected schema.
    const items =
      settings.dataSource === 'web'
        ? this.normalizeWebItems(sourceResult.items)
        : sourceResult.items;

    // First-fill vs incremental: on cold boot the index is empty → hydrate,
    // broadcast bib:initial so renderer rehydrates the whole library. Subsequent
    // refreshes (window focus or manual) go through diff + applyPatch and only
    // broadcast changed bib:patch; when nothing changed, fall back to bib:status
    // so renderer drops the "syncing" spinner.
    const isFirstFill = this.index.size() === 0;
    // Web mode has no BBT concept — ready as long as source is reachable.
    // Local mode: BBT down = degraded (keys fall back to 8-char itemKey).
    const nextStatus = resolveNextStatus(settings.dataSource, bbtHealthResult.ok);

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
    const finalDetail = resolveFinalDetail(settings.dataSource, bbtHealthResult.ok);
    this.transition(nextStatus, finalDetail);
    return { triggered: true, status: nextStatus };
  }

  /**
   * Probe + fetch items from whichever data source is active. Mode
   * branching lives inside `resolveActiveSource()` (one place); this method
   * is mode-agnostic — it works with any `ZoteroDataSource` implementation,
   * so adding a third backend (group libraries, alt-cloud) is one new
   * class, zero new branches here.
   *
   * Takes a `dataSource` snapshot (not read from settings inline) so the
   * caller controls consistency across the whole refresh — see doRefresh's
   * pinning comment.
   */
  private async fetchActiveSource(
    dataSource: ZoteroDataSource
  ): Promise<{ ok: true; items: ZoteroItemDTO[] } | { ok: false; error: string }> {
    const source = this.resolveActiveSource(dataSource);
    if (!source) {
      return {
        ok: false,
        error: 'Zotero data source not configured (web mode: missing userId or API key)',
      };
    }
    try {
      const probe = await source.ping();
      if (!probe.ok) {
        return { ok: false, error: probe.error ?? `Zotero ${source.kind} source unreachable` };
      }
      const items = await source.getAllItems();
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Populate `localApiProbe` / `webApiProbe` / `bbtProbe` snapshots from
   * per-mode fetch results so getDiagnostics() reports the whole picture,
   * not just whichever source was active this refresh.
   */
  private recordProbes(
    active: ZoteroDataSource,
    activeError: string | undefined,
    bbtHealth: { ok: boolean; error?: string; skipped?: boolean }
  ): void {
    if (active === 'web') {
      this.webApiProbe = activeError ? { ok: false, error: activeError } : { ok: true };
      // Local + BBT probes are stale in web mode; explicitly mark them skipped
      // rather than leaking previous mode's success — else UI would report
      // "everything green" even when local Zotero is down.
      this.localApiProbe = { ok: false, detail: 'skipped in web mode' };
      this.bbtProbe = { ok: false, detail: 'skipped in web mode' };
      return;
    }
    this.localApiProbe = activeError ? { ok: false, error: activeError } : { ok: true };
    this.bbtProbe = bbtHealth.ok ? { ok: true } : { ok: false, error: bbtHealth.error };
    this.webApiProbe = { ok: false, detail: 'skipped in local mode' };
  }

  /**
   * Web-mode citation-key normalization (3-layer fallback):
   *   1. `data.citationKey` present (BBT was ever run + synced to cloud)
   *      → trust it, echo into the store so subsequent renders match, tag origin='bbt'
   *   2. Store has a record → reuse that key + its recorded origin (user_override
   *      wins over prior studio_mint)
   *   3. Neither → mint a fresh key, tag origin='studio_mint', persist
   *
   * Runs on every fetched item exactly once per refresh; deterministic
   * given the same store contents + item set. If keyStore is unavailable
   * (e.g., a test forgot to inject one) the pass-through is a no-op —
   * citation keys stay as-is and no persistence happens.
   */
  private normalizeWebItems(items: ZoteroItemDTO[]): ZoteroItemDTO[] {
    const store = this.keyStore;
    if (!store) return items;
    // getAllExistingKeys can throw on sqlite failure (db lock, corruption).
    // Fall through with pass-through items so the whole refresh doesn't crash;
    // a subsequent refresh will retry the store read once conditions clear.
    let existing: Set<string>;
    try {
      existing = store.getAllExistingKeys();
    } catch (err) {
      logger.warn('[Zotero] getAllExistingKeys failed; skipping citation key normalization', {
        error: err instanceof Error ? err.message : String(err),
      });
      return items;
    }
    // Snapshot BEFORE loop so a fresh mint in item[i] can collide against a
    // fresh mint from item[i-1] (both go into the local `minted` seen set,
    // NOT into the DB set — put() happens per-item and would race if we
    // recomputed the getAllExistingKeys() inside the loop).
    const minted = new Set<string>();
    return items.map((item) => this.normalizeOneWebItem(item, store, existing, minted));
  }

  private normalizeOneWebItem(
    item: ZoteroItemDTO,
    store: CitationKeyStore,
    existing: Set<string>,
    minted: Set<string>
  ): ZoteroItemDTO {
    const bbtKey = item.citationKey?.trim();
    // Layer 1: BBT-synced key wins IF it's not already claimed. Two items with
    // the same BBT `citationKey` (rare but possible when users hand-edit
    // Zotero data.citationKey) would otherwise both echo the duplicate,
    // producing ambiguous bib entries. Fall through to Layer 3 minting so
    // the collision resolves via a postfix (e.g. smith2024deep → smith2024deepa).
    if (bbtKey && !existing.has(bbtKey)) {
      try {
        store.updateFromBbt(item.itemKey, bbtKey);
      } catch (err) {
        logger.warn('[Zotero] Failed to reconcile BBT citation key in store', {
          itemKey: item.itemKey,
          key: bbtKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      existing.add(bbtKey);
      return { ...item, citationKey: bbtKey, citationKeyOrigin: 'bbt' };
    }
    // Layer 2: earlier studio_mint or user_override; keep origin as-is. Store
    // read failures are non-fatal — degrade to Layer 3 minting rather than
    // crashing the whole refresh cycle.
    let stored: { key: string; origin: ZoteroCitationKeyOrigin } | null = null;
    try {
      stored = store.get(item.itemKey);
    } catch (err) {
      logger.warn('[Zotero] Failed to read stored citation key', {
        itemKey: item.itemKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (stored) {
      existing.add(stored.key);
      return { ...item, citationKey: stored.key, citationKeyOrigin: stored.origin };
    }
    // Layer 3: no prior state; mint against union of DB + this-batch mints.
    const conflictSet = new Set<string>([...existing, ...minted]);
    const fresh = mintCitationKey(
      {
        title: item.title,
        year: item.year,
        // Minter needs raw creators; DTO only carries the flattened label. Use
        // creatorsLabel as a single-word surrogate — good enough for the vast
        // majority of items, and BBT reconciliation later will overwrite.
        creators: item.creatorsLabel ? [{ lastName: firstToken(item.creatorsLabel) }] : undefined,
      },
      conflictSet
    );
    const origin: ZoteroCitationKeyOrigin = 'studio_mint';
    try {
      store.put(item.itemKey, fresh, origin);
    } catch (err) {
      logger.warn('[Zotero] Failed to persist minted citation key', {
        itemKey: item.itemKey,
        key: fresh,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    minted.add(fresh);
    return { ...item, citationKey: fresh, citationKeyOrigin: origin };
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
    a.citationKeyOrigin === b.citationKeyOrigin &&
    a.citation === b.citation &&
    a.bib === b.bib &&
    a.abstractNote === b.abstractNote
  );
}

/**
 * Extract the first author-like token from a flattened creatorsLabel like
 * "Smith, Jones et al." — used only in the web-mode minter fallback where
 * we've already lost the raw creators array. Not exhaustive; BBT-synced
 * items skip this path entirely.
 */
function firstToken(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '';
  const commaCut = trimmed.split(',')[0].trim();
  const spaceCut = commaCut.split(/\s+/)[0];
  return spaceCut;
}

/**
 * Compute the post-refresh BibStatus. Extracted from doRefresh so the
 * two-dimension decision (dataSource × bbtHealth) reads as a table
 * instead of a nested ternary — per CLAUDE.md's "no nested ternary" rule.
 */
function resolveNextStatus(dataSource: ZoteroDataSource, bbtOk: boolean): BibStatus {
  if (dataSource === 'web') return 'ready';
  if (bbtOk) return 'ready';
  return 'degraded';
}

/**
 * Detail string paired with the status transition. Web mode never has a
 * BBT-related detail (no BBT concept applies); local mode surfaces
 * "BBT unavailable" when BBT is down so the StatusBadge can explain why
 * the state is degraded.
 */
function resolveFinalDetail(dataSource: ZoteroDataSource, bbtOk: boolean): string | undefined {
  if (dataSource === 'web') return undefined;
  if (bbtOk) return undefined;
  return 'BBT unavailable';
}

let singleton: ZoteroOrchestrator | null = null;

/**
 * Get the production ZoteroOrchestrator singleton. Wires up real defaults for
 * web-mode support:
 *   - `getWebApiClient` reads userId (config) + apiKey (SecureStorage) each call,
 *     so credential changes take effect on the next refresh without needing
 *     to invalidate the singleton
 *   - `keyStore` uses the process-wide CitationKeyStore rooted at userData
 *   - `getSettings` reads current dataSource / hasWebApiKey from ConfigManager
 *     + SecureStorage each call (cheap: no decrypt on hasWebApiKey path)
 *
 * Tests should construct `new ZoteroOrchestrator({...})` directly with mocks;
 * the singleton is intentionally not exposed for override.
 */
/**
 * Bump when Zotero web credentials change (`Zotero_SetWebApiKey` /
 * `Zotero_ClearWebApiKey` handlers, or settings-driven userId edits).
 * The singleton's `getWebApiClient` factory memoizes by this version and
 * skips a keychain decrypt on every refresh — decrypting `safeStorage`
 * costs ~1ms and refresh can fire on every window focus, so this matters
 * for battery/CPU on high-frequency alt-tabbers.
 */
let webCredentialsVersion = 0;

export function invalidateWebApiCredentials(): void {
  webCredentialsVersion++;
}

export function getZoteroOrchestrator(): ZoteroOrchestrator {
  if (!singleton) {
    const readDataSource = (): ZoteroDataSource => {
      const raw = configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local');
      return raw === 'web' ? 'web' : 'local';
    };
    // Memoize WebApiClient by (userId, credentialsVersion). Only rebuilds
    // when userId changes or invalidateWebApiCredentials() bumps the version
    // (i.e., user set/cleared the key via handler) — otherwise re-uses the
    // cached client, avoiding a safeStorage decrypt on every refresh.
    let cachedClient: { client: ZoteroWebApiClient; userId: string; version: number } | null = null;
    // CitationKeyStore construction can fail on disk full / permission /
    // corrupted db. Without a guard, `getZoteroOrchestrator()` would throw
    // and leave `singleton` unassigned → every subsequent handler call
    // retries the same failing open → the whole zotero surface stays broken
    // even after transient fs pressure clears. Degrade to keyStore=null so
    // the orchestrator can still serve local mode without persistence;
    // web-mode citation-key normalization gracefully skips (already guarded
    // in normalizeWebItems).
    let keyStore: CitationKeyStore | null;
    try {
      keyStore = getCitationKeyStore();
    } catch (err) {
      logger.warn('[Zotero] CitationKeyStore init failed; running without persistence', {
        error: err instanceof Error ? err.message : String(err),
      });
      keyStore = null;
    }
    singleton = new ZoteroOrchestrator({
      // undefined = "use no keyStore" (matches OrchestratorDeps optional).
      keyStore: keyStore ?? undefined,
      getSettings: () => ({
        dataSource: readDataSource(),
        webApiUserId: configManager.get<string>(ConfigKeys.ZoteroWebApiUserId, ''),
        hasWebApiKey: secureHas(SecureStorageKeys.ZoteroWebApiKey),
      }),
      getWebApiClient: () => {
        const userId = configManager.get<string>(ConfigKeys.ZoteroWebApiUserId, '').trim();
        if (!userId) {
          cachedClient = null;
          return null;
        }
        if (
          cachedClient &&
          cachedClient.userId === userId &&
          cachedClient.version === webCredentialsVersion
        ) {
          return cachedClient.client;
        }
        const apiKey = getZoteroWebApiKey();
        if (!apiKey) {
          cachedClient = null;
          return null;
        }
        const client = new ZoteroWebApiClient({ userId, apiKey });
        cachedClient = { client, userId, version: webCredentialsVersion };
        return client;
      },
    });
  }
  return singleton;
}
