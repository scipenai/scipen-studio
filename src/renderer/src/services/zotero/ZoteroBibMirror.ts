/**
 * @file ZoteroBibMirror — renderer-side canonical bib index mirror
 * @description Single instance mirroring the main-process ZoteroIndex (full
 *              data + incremental patches). Subscribes to the `Zotero_Event`
 *              channel, maintains `items` / `keyToItem` plus a cite-specific
 *              inverted index (citation-key prefix + token + haystack), and
 *              exposes itself to React via `subscribe` (useSyncExternalStore
 *              compatible). Diagnostics (datasource health) are fetched on
 *              demand via IPC, not cached in the mirror.
 *
 *              Lifecycle:
 *                disabled (idle) → start() → subscribe + pull full
 *                                  getSnapshot
 *                                  → bib:initial/patch/status increments
 *                                  → dispose() cleans up (unsubscribe + clear)
 *
 *              IPC ordering — subscribe before pulling the snapshot so any
 *              patch arriving mid-flight is preserved. Snapshot and patches
 *              each carry an etag; the mirror dedupes on "already applied".
 *
 *              Search scoring lives in bibSearchScoring.ts (three tiers:
 *              citation-key prefix → token intersection → substring fallback).
 *              Ported from the m2-stash Worker implementation.
 */

import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';
import type {
  BibSnapshotDTO,
  BibStatus,
  GetSnapshotResultDTO,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
  ZoteroEventDTO,
} from '../../../../../shared/types/zotero-events';
import { api } from '../../api';
import { createLogger } from '../LogService';
import {
  buildHaystack,
  searchBibCorpus,
  tokenize,
  type BibSearchHit,
  type RecallMode,
} from './bibSearchScoring';

const logger = createLogger('ZoteroBibMirror');

/** Minimal state slice consumed by view layers (paired with useSyncExternalStore). */
export interface ZoteroBibMirrorState {
  status: BibStatus;
  etag: string;
  itemCount: number;
  /** ISO 8601 string; undefined until the first hydrate. */
  lastSyncedAt?: string;
  /** Whether the mirror has completed its first successful hydrate. */
  ready: boolean;
}

type Listener = () => void;

const INITIAL_STATE: ZoteroBibMirrorState = {
  status: 'idle',
  etag: '',
  itemCount: 0,
  ready: false,
};

export class ZoteroBibMirror {
  private items = new Map<string, ZoteroItemDTO>();
  /** Case-sensitive citationKey → itemKey; used by getByCitationKey. */
  private keyToItem = new Map<string, string>();
  /** Lowercase citationKey → itemKey; used for prefix matching during search. */
  private citationKeyLower = new Map<string, string>();
  /** token (lowercase, ≥2 chars) → set of itemKeys; used for token scoring. */
  private tokenIndex = new Map<string, Set<string>>();
  /** itemKey → lowercase concatenated haystack; used by substring fallback. */
  private haystacks = new Map<string, string>();

  private state: ZoteroBibMirrorState = INITIAL_STATE;
  private stateSnapshot: ZoteroBibMirrorState = INITIAL_STATE;

  private readonly listeners = new Set<Listener>();
  private unsubEvent: (() => void) | null = null;
  private starting = false;
  private disposed = false;

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Start the mirror — subscribe to events, pull the initial snapshot.
   * Re-entrant safe (concurrent calls collapse to one). After stop() the
   * mirror may be started again; dispose() is terminal and ignores start.
   */
  async start(): Promise<void> {
    if (this.disposed || this.starting || this.state.ready) return;
    this.starting = true;
    try {
      // Subscribe before pulling the snapshot; otherwise any patch arriving
      // mid-flight would be lost.
      this.unsubEvent = api.zotero.onEvent((event) => this.handleEvent(event));

      const snapshot = await api.zotero.getSnapshot({});
      this.applySnapshotResult(snapshot);
    } catch (err) {
      logger.warn('start: initial getSnapshot failed', err);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Stop the mirror — unsubscribe, clear data, reset state to idle.
   * **Retains** subscribe listeners so the UI still observes the return to
   * idle; a subsequent start() can resume normally.
   */
  stop(): void {
    this.unsubEvent?.();
    this.unsubEvent = null;
    this.items.clear();
    this.keyToItem.clear();
    this.citationKeyLower.clear();
    this.tokenIndex.clear();
    this.haystacks.clear();
    this.state = INITIAL_STATE;
    this.bumpSnapshot();
  }

  /** Terminal — stop + drop subscribe listeners. Tests / process exit only. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  // ============================================================
  // Subscription (useSyncExternalStore-friendly)
  // ============================================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns a stable reference: only swaps to a new object after state
   * changes, so it can drive useSyncExternalStore directly. */
  getState(): ZoteroBibMirrorState {
    return this.stateSnapshot;
  }

  // ============================================================
  // Sync reads
  // ============================================================

  getByCitationKey(citationKey: string): ZoteroItemDTO | undefined {
    if (!citationKey) return undefined;
    const itemKey = this.keyToItem.get(citationKey);
    return itemKey ? this.items.get(itemKey) : undefined;
  }

  getByItemKey(itemKey: string): ZoteroItemDTO | undefined {
    return this.items.get(itemKey);
  }

  /** All entries (empty-query completion fallback: typing `@` with no chars
   * yet should list every reference). */
  getAllItems(): ZoteroItemDTO[] {
    return Array.from(this.items.values());
  }

  /**
   * Return cite candidates with scores (for dropdown / completion-provider
   * sorting). Scoring semantics live in `bibSearchScoring.ts` (citation-key
   * prefix → token intersection → substring). `mode` follows RecallMode:
   * keystroke completion passes 'prefix-only', search box / LLM tools use
   * the default 'full'.
   */
  searchByQueryWithScore(query: string, limit = 20, mode: RecallMode = 'full'): BibSearchHit[] {
    return searchBibCorpus(
      {
        items: this.items,
        citationKeyIndex: this.citationKeyLower,
        tokenIndex: this.tokenIndex,
        haystacks: this.haystacks,
      },
      query,
      limit,
      mode
    );
  }

  /** Legacy-caller convenience: return the sorted ZoteroItemDTO list and drop score. */
  searchByQuery(query: string, limit = 20): ZoteroItemDTO[] {
    return this.searchByQueryWithScore(query, limit).map((h) => h.item);
  }

  // ============================================================
  // Async surface (proxies main)
  // ============================================================

  /** Trigger a refresh (subject to main's cooldown debounce). */
  async refresh(): Promise<RefreshResultDTO> {
    return api.zotero.requestRefresh();
  }

  /** Fetch full diagnostics (including datasource health). Popover calls on
   * demand; not cached in state. */
  async fetchDiagnostics(): Promise<ZoteroDiagnosticsDTO> {
    return api.zotero.getDiagnostics();
  }

  // ============================================================
  // Event handling
  // ============================================================

  private handleEvent(event: ZoteroEventDTO): void {
    if (this.disposed) return;
    switch (event.kind) {
      case 'bib:initial':
        this.applyInitial(event.snapshot);
        break;
      case 'bib:patch':
        if (event.etag === this.state.etag) return; // Already applied (race guard).
        this.applyDelta(event.upserts, event.deletes, event.etag, event.status);
        break;
      case 'bib:status':
        if (this.state.status !== event.status) {
          this.state = { ...this.state, status: event.status };
          this.bumpSnapshot();
        }
        break;
      case 'bib:invalidated':
        // Pure informational event — a bib:status('syncing') or bib:patch
        // will follow; no immediate action required.
        break;
    }
  }

  private applySnapshotResult(result: GetSnapshotResultDTO): void {
    if (result.reset) {
      this.replaceAll(result.items, result.etag, result.status);
    } else {
      this.applyDelta(result.upserts, result.deletes, result.etag, result.status);
    }
  }

  private applyInitial(snapshot: BibSnapshotDTO): void {
    this.replaceAll(snapshot.items, snapshot.etag, snapshot.status);
  }

  private replaceAll(items: ZoteroItemDTO[], etag: string, status: BibStatus): void {
    this.items.clear();
    this.keyToItem.clear();
    this.citationKeyLower.clear();
    this.tokenIndex.clear();
    this.haystacks.clear();
    for (const item of items) {
      this.indexItem(item);
    }
    this.state = {
      status,
      etag,
      itemCount: this.items.size,
      lastSyncedAt: new Date().toISOString(),
      ready: true,
    };
    this.bumpSnapshot();
  }

  private applyDelta(
    upserts: ZoteroItemDTO[],
    deletes: string[],
    etag: string,
    status: BibStatus
  ): void {
    for (const itemKey of deletes) {
      this.unindexItem(itemKey);
    }
    for (const item of upserts) {
      if (!item.itemKey) continue;
      // Unindex the old item before upserting (citationKey/token/haystack
      // may have changed).
      if (this.items.has(item.itemKey)) {
        this.unindexItem(item.itemKey);
      }
      this.indexItem(item);
    }
    this.state = {
      status,
      etag,
      itemCount: this.items.size,
      lastSyncedAt: new Date().toISOString(),
      ready: true,
    };
    this.bumpSnapshot();
  }

  private indexItem(item: ZoteroItemDTO): void {
    this.items.set(item.itemKey, item);
    if (item.citationKey) {
      this.keyToItem.set(item.citationKey, item.itemKey);
      this.citationKeyLower.set(item.citationKey.toLowerCase(), item.itemKey);
    }
    const haystack = buildHaystack(item);
    this.haystacks.set(item.itemKey, haystack);
    const seen = new Set<string>();
    for (const tok of tokenize(haystack)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      let set = this.tokenIndex.get(tok);
      if (!set) {
        set = new Set();
        this.tokenIndex.set(tok, set);
      }
      set.add(item.itemKey);
    }
  }

  private unindexItem(itemKey: string): void {
    const existing = this.items.get(itemKey);
    if (!existing) return;
    this.items.delete(itemKey);
    if (existing.citationKey) {
      const lower = existing.citationKey.toLowerCase();
      if (this.keyToItem.get(existing.citationKey) === itemKey) {
        this.keyToItem.delete(existing.citationKey);
      }
      if (this.citationKeyLower.get(lower) === itemKey) {
        this.citationKeyLower.delete(lower);
      }
    }
    const haystack = this.haystacks.get(itemKey);
    this.haystacks.delete(itemKey);
    if (haystack) {
      const seen = new Set<string>();
      for (const tok of tokenize(haystack)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        const set = this.tokenIndex.get(tok);
        if (set) {
          set.delete(itemKey);
          if (set.size === 0) this.tokenIndex.delete(tok);
        }
      }
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private bumpSnapshot(): void {
    this.stateSnapshot = this.state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn('subscriber threw', err);
      }
    }
  }
}

let singleton: ZoteroBibMirror | null = null;

export function getZoteroBibMirror(): ZoteroBibMirror {
  if (!singleton) {
    singleton = new ZoteroBibMirror();
  }
  return singleton;
}

/** Tests only: reset the singleton. */
export function __resetZoteroBibMirrorSingleton(): void {
  singleton?.dispose();
  singleton = null;
}
