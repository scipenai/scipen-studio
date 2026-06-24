/**
 * @file ZoteroIndex — canonical, in-memory bib index living in main
 * @description Single source of truth for everything cite-related.
 *              Holds `items` by `itemKey`, a reverse `citationKey →
 *              itemKey` map, and a trigram index for `@cite:` fuzzy
 *              lookup. Synchronous getters (`getByCitationKey`, ...)
 *              are deliberately blocking because callers are all in
 *              the main process and the work is sub-microsecond.
 *
 *              The index itself does no I/O — it's a pure data
 *              structure. The orchestrator decides when to `hydrate`
 *              / `applyPatch` from BBT / LocalApi.
 *
 *              Etag semantics: a monotonic version string that bumps on
 *              every mutation. Renderer carries it across reconnects to
 *              pull only the delta.
 *
 *              Delta log: each patch appends `{etag, upserts, deletes}`
 *              to a bounded ring. Renderer can request snapshot
 *              `since: etag`; if the cursor predates the oldest log
 *              entry we return a full reset instead.
 */

import { randomUUID } from 'crypto';
import type {
  BibPatchDTO,
  BibResetDTO,
  BibStatus,
  GetSnapshotResultDTO,
  BibSnapshotDTO,
} from '../../../../shared/types/zotero-events';
import type { ZoteroItemDTO } from '../../../../shared/types/zotero';
import { TrigramIndex } from '../../../../shared/utils/trigram';

/** Maximum delta log entries we keep before forcing renderer to reset. */
const DEFAULT_DELTA_LOG_CAPACITY = 64;

interface DeltaEntry {
  etag: string;
  upserts: ZoteroItemDTO[];
  deletes: string[];
}

export interface ApplyPatchResult {
  etag: string;
  upserts: ZoteroItemDTO[];
  deletes: string[];
}

export class ZoteroIndex {
  private items: Map<string, ZoteroItemDTO> = new Map();
  private keyToItem: Map<string, string> = new Map();
  private trigram = new TrigramIndex<string>();
  private currentEtag = '';
  private hydrationEtag = '';
  private hasEvicted = false;
  private status: BibStatus = 'idle';
  private deltaLog: DeltaEntry[] = [];
  private readonly deltaCapacity: number;

  constructor(deltaCapacity: number = DEFAULT_DELTA_LOG_CAPACITY) {
    this.deltaCapacity = deltaCapacity;
  }

  // ============================================================
  // Mutators
  // ============================================================

  /**
   * Replace the entire index with `items`. Bumps etag, clears the delta
   * log (since renderers must full-rehydrate after a reset).
   */
  hydrate(items: ZoteroItemDTO[], status: BibStatus = 'ready'): string {
    this.items.clear();
    this.keyToItem.clear();
    this.trigram.clear();
    this.deltaLog = [];

    for (const item of items) {
      this.indexItem(item);
    }

    this.currentEtag = newEtag();
    this.hydrationEtag = this.currentEtag;
    this.hasEvicted = false;
    this.status = status;
    return this.currentEtag;
  }

  /**
   * Apply incremental upserts/deletes. Returns the new etag and the
   * effective changeset (deletes are filtered to keys that were actually
   * present so renderer mirrors don't get phantom deletes).
   */
  applyPatch(
    upserts: ZoteroItemDTO[],
    deletes: string[],
    status: BibStatus = 'ready'
  ): ApplyPatchResult {
    const effectiveDeletes: string[] = [];
    for (const itemKey of deletes) {
      const existing = this.items.get(itemKey);
      if (!existing) continue;
      this.items.delete(itemKey);
      this.trigram.remove(itemKey);
      if (existing.citationKey) {
        const back = this.keyToItem.get(existing.citationKey);
        if (back === itemKey) this.keyToItem.delete(existing.citationKey);
      }
      effectiveDeletes.push(itemKey);
    }

    const effectiveUpserts: ZoteroItemDTO[] = [];
    for (const item of upserts) {
      if (!item.itemKey) continue;
      // Drop stale citation-key reverse mapping if the upsert renames the key.
      const prior = this.items.get(item.itemKey);
      if (prior?.citationKey && prior.citationKey !== item.citationKey) {
        const back = this.keyToItem.get(prior.citationKey);
        if (back === item.itemKey) this.keyToItem.delete(prior.citationKey);
      }
      this.indexItem(item);
      effectiveUpserts.push(item);
    }

    this.currentEtag = newEtag();
    this.status = status;

    if (effectiveUpserts.length > 0 || effectiveDeletes.length > 0) {
      this.deltaLog.push({
        etag: this.currentEtag,
        upserts: effectiveUpserts,
        deletes: effectiveDeletes,
      });
      while (this.deltaLog.length > this.deltaCapacity) {
        this.deltaLog.shift();
        this.hasEvicted = true;
      }
    }

    return {
      etag: this.currentEtag,
      upserts: effectiveUpserts,
      deletes: effectiveDeletes,
    };
  }

  setStatus(status: BibStatus): void {
    this.status = status;
  }

  // ============================================================
  // Sync reads (called by SNACA reverse-RPC + IPC handlers)
  // ============================================================

  getByCitationKey(citationKey: string): ZoteroItemDTO | undefined {
    if (!citationKey) return undefined;
    const itemKey = this.keyToItem.get(citationKey);
    return itemKey ? this.items.get(itemKey) : undefined;
  }

  getByItemKey(itemKey: string): ZoteroItemDTO | undefined {
    return this.items.get(itemKey);
  }

  searchSync(query: string, limit = 20): ZoteroItemDTO[] {
    if (!query.trim()) return [];
    const hits = this.trigram.search(query, limit);
    const out: ZoteroItemDTO[] = [];
    for (const hit of hits) {
      const item = this.items.get(hit.id);
      if (item) out.push(item);
    }
    return out;
  }

  getEtag(): string {
    return this.currentEtag;
  }

  size(): number {
    return this.items.size;
  }

  values(): IterableIterator<ZoteroItemDTO> {
    return this.items.values();
  }

  // ============================================================
  // Snapshot building (IPC handler entry points)
  // ============================================================

  buildSnapshot(): BibSnapshotDTO {
    return {
      status: this.status,
      etag: this.currentEtag,
      items: Array.from(this.items.values()),
    };
  }

  /**
   * Build a delta from `since` if possible, else fall back to a full
   * reset. `since` may be omitted (initial bootstrap) or stale (renderer
   * was offline through > `deltaCapacity` patches).
   *
   * Cursor resolution:
   *  - undefined / current   → full reset (no cursor → renderer wants a fresh hydrate)
   *  - hydrationEtag         → replay the entire deltaLog forward
   *  - log entry etag        → replay deltaLog after that entry
   *  - else                  → cursor is stale or unknown; force full reset
   */
  buildSnapshotSince(since?: string): GetSnapshotResultDTO {
    if (!since || since === this.currentEtag) {
      return this.buildFullReset();
    }

    let startIndex: number;
    if (since === this.hydrationEtag) {
      // hydrationEtag covers the *complete* log from index 0, but only
      // while no entries have been evicted from the front. After
      // eviction the renderer's cursor has lost coverage of the deleted
      // patches and must do a full reset.
      if (this.hasEvicted) {
        return this.buildFullReset();
      }
      startIndex = -1; // replay log from index 0
    } else {
      const found = this.deltaLog.findIndex((entry) => entry.etag === since);
      if (found === -1) {
        return this.buildFullReset();
      }
      startIndex = found;
    }

    // Aggregate upserts/deletes from (since, current]. We replay the log
    // forward so the last write wins and we don't repeat duplicates.
    const upsertMap = new Map<string, ZoteroItemDTO>();
    const deleteSet = new Set<string>();
    for (let i = startIndex + 1; i < this.deltaLog.length; i++) {
      const entry = this.deltaLog[i];
      if (!entry) continue;
      for (const item of entry.upserts) {
        upsertMap.set(item.itemKey, item);
        deleteSet.delete(item.itemKey);
      }
      for (const id of entry.deletes) {
        upsertMap.delete(id);
        deleteSet.add(id);
      }
    }

    const patch: BibPatchDTO = {
      status: this.status,
      etag: this.currentEtag,
      reset: false,
      upserts: Array.from(upsertMap.values()),
      deletes: Array.from(deleteSet),
    };
    return patch;
  }

  private buildFullReset(): BibResetDTO {
    return {
      status: this.status,
      etag: this.currentEtag,
      reset: true,
      items: Array.from(this.items.values()),
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  private indexItem(item: ZoteroItemDTO): void {
    this.items.set(item.itemKey, item);
    if (item.citationKey) {
      this.keyToItem.set(item.citationKey, item.itemKey);
    }

    const tokens = [
      item.citationKey ?? '',
      item.title ?? '',
      item.creatorsLabel ?? '',
      item.year ? String(item.year) : '',
    ];
    // Whole-item weighting: items with a citationKey get an overall score
    // multiplier of 1.5, so @cite fuzzy matches favour entries that
    // already have a key (title hits get the boost too, with no observed
    // UX downside — the literature users look for usually already has a
    // citation key assigned).
    const compound = tokens.filter(Boolean).join(' ');
    this.trigram.upsert(item.itemKey, compound, item.citationKey ? 1.5 : 1.0);
  }
}

function newEtag(): string {
  return randomUUID();
}
