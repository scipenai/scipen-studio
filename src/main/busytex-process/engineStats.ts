/**
 * @file busytex-process/engineStats.ts — per-call IO accounting
 *
 * Exists because the synchronous kpathsea path spawns ONE curl process per
 * cache miss: wall-clock is driven by miss COUNT, not by byte volume, and on
 * Windows every spawn additionally pays CreateProcess plus AV scanning. None
 * of that is observable from outside the process, which left "the compile is
 * slow" unattributable. Reset per load/compile and reported when that call
 * settles.
 *
 * One mutable object shared by every recorder; it is reset in place (never
 * reassigned) so importers always hold the live instance.
 */

export interface EngineStats {
  /** Local asset reads (wasm, data packages) — no network involved. */
  diskReads: number;
  diskBytes: number;
  /** Remote lookups served from the on-disk TeX Live cache (cheap path). */
  cacheHits: number;
  /** Cache misses that went to the network, by outcome. */
  fetched200: number;
  /** kpse probing for a file that does not exist — the dominant miss kind. */
  fetched404: number;
  fetchErrors: number;
  /** Cumulative wall-clock inside curl (process spawn + transfer). */
  curlMs: number;
  /** Cumulative wall-clock in cache lookups (stat + read). */
  cacheMs: number;
  fetchedBytes: number;
}

function emptyStats(): EngineStats {
  return {
    diskReads: 0,
    diskBytes: 0,
    cacheHits: 0,
    fetched200: 0,
    fetched404: 0,
    fetchErrors: 0,
    curlMs: 0,
    cacheMs: 0,
    fetchedBytes: 0,
  };
}

/** Single window; compiles are serialized by the worker's one pending slot. */
export const stats: EngineStats = emptyStats();

/** Snapshot the current window and open a fresh one. */
export function resetStats(): EngineStats {
  const snapshot = { ...stats };
  Object.assign(stats, emptyStats());
  return snapshot;
}
