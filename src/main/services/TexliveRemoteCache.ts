/**
 * @file TexliveRemoteCache - Disk cache for the BusyTeX TeX Live remote proxy
 * @description Caches responses proxied by `handleTexliveRemote`
 *              (`WasmAssetProtocol`) so on-demand TeX Live fetches
 *              (ctex/xeCJK styles, Fandol fonts, tfm/vf files...) paid once
 *              per URL survive worker restarts, engine cancels, and app
 *              relaunches. Without it every fetch lives only in the worker's
 *              in-memory WASM FS, so a BusyTeX cold start re-downloads the
 *              full set over synchronous XHR from the remote endpoint.
 *
 * Design notes:
 *   - Pure Node (fs/path/crypto), no electron import — the cache dir is
 *     injected by the caller. Keeps the module unit-testable in vitest.
 *   - Cache key is the FULL remote URL (endpoint base + format + name).
 *     Users pointing Settings → Compiler at a different mirror automatically
 *     get a different key space; two mirrors never cross-contaminate.
 *   - Neither 200s nor 404 misses have a TTL, for the same reason: the
 *     endpoint serves an immutable TeX Live snapshot, and a URL with
 *     different content would be a different endpoint (different key).
 *     Immutability is symmetric — a snapshot that lacks a file today will
 *     not grow one tomorrow — so expiring misses only bought a periodic
 *     re-probe storm. kpathsea produces hundreds of miss requests per
 *     compile (546 on a real CJK project), each costing a curl process and
 *     a network RTT, so a miss that expires is a multi-minute regression.
 *     Switching mirrors is already isolated by the key space; the stale
 *     mirror's misses stay on disk forever by design. A mirror that later
 *     gains a file, or a CDN that wrongly answered 404, is recovered by
 *     Settings → Compiler → clear the 404 records.
 *   - On-disk format is unchanged by the TTL removal, so downgrading to an
 *     older build merely restores expiry. No schema version needed.
 *   - 5xx / network errors are never cached — `handleTexliveRemote`
 *     deliberately returns 502 so BusyTeX does not record a permanent miss.
 *   - Every cache error is swallowed into a "no cache" outcome: the compile
 *     must succeed exactly as it did before this module existed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Default cache ceiling. Fandol CJK fonts alone are ~50 MB; 1 GB leaves
 *  headroom for several projects without creeping unbounded. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

export interface CacheEntry {
  status: 200 | 404;
  body: Buffer | null;
}

export interface TexliveCacheStats {
  /** Requests answered from disk (200 content). */
  hits: number;
  /** Requests answered by a cached 404 marker. */
  missHits: number;
  /** 200 payloads written to disk. */
  stores: number;
  /** 404 markers written to disk. */
  missStores: number;
  /** Requests that went to the network instead of the cache. */
  networkFetches: number;
  /** Body bytes served from disk (for hit-rate reporting). */
  bytesServed: number;
  /** Body bytes received from the network and stored. */
  bytesStored: number;
}

export interface TexliveRemoteCacheOptions {
  cacheDir: string;
  maxBytes?: number;
}

/**
 * Strict entry-name matchers. Everything written here is `<sha256>.bin` or
 * `<sha256>.miss`; anything else in the directory is either an in-flight
 * transfer (`<dest>.<pid>.<hex>.tmp` from put/putMiss, `.fetch-<pid>-<hex>`
 * written by the engine process's curl) or a foreign file. Bulk operations
 * MUST match against these rather than a suffix test — deleting a live
 * `.fetch-*` makes the engine read back an empty body and cache it as a
 * permanent 200 (see busytex-process/index.ts).
 */
const ENTRY_BIN_RE = /^[0-9a-f]{64}\.bin$/;
const ENTRY_MISS_RE = /^[0-9a-f]{64}\.miss$/;

/** Directory census used by the settings UI. */
export interface TexliveCacheUsage {
  /** Cached 200 payloads (packages, fonts). */
  binCount: number;
  binBytes: number;
  /** Cached 404 probe results — zero-byte markers, so no byte count. */
  missCount: number;
}

export class TexliveRemoteCache {
  private readonly cacheDir: string;
  private readonly maxBytes: number;
  readonly stats: TexliveCacheStats = {
    hits: 0,
    missHits: 0,
    stores: 0,
    missStores: 0,
    networkFetches: 0,
    bytesServed: 0,
    bytesStored: 0,
  };

  constructor(options: TexliveRemoteCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** sha256 of the full remote URL — collision-safe key space. */
  private keyFor(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  private contentPath(url: string): string {
    return path.join(this.cacheDir, `${this.keyFor(url)}.bin`);
  }

  private missPath(url: string): string {
    return path.join(this.cacheDir, `${this.keyFor(url)}.miss`);
  }

  /**
   * Look up a cached response. Returns null on any miss, expiry, or I/O
   * failure — callers then fall through to the network.
   */
  async get(url: string): Promise<CacheEntry | null> {
    try {
      const missPath = this.missPath(url);
      if (fs.existsSync(missPath)) {
        this.stats.missHits += 1;
        return { status: 404, body: null };
      }

      const contentPath = this.contentPath(url);
      if (!fs.existsSync(contentPath)) return null;
      const body = await fs.promises.readFile(contentPath);
      this.stats.hits += 1;
      this.stats.bytesServed += body.byteLength;
      // Refresh mtime so LRU eviction sees this entry as recently used.
      // Guarded separately: the touch is decorative bookkeeping and must not
      // be able to veto a body we already read. Without its own catch, an
      // ENOENT here (entry cleared concurrently) would drop a valid payload
      // on the floor and send the caller to the network.
      try {
        const now = new Date();
        fs.utimesSync(contentPath, now, now);
      } catch {
        // LRU touch failed; the hit still stands.
      }
      return { status: 200, body };
    } catch {
      return null;
    }
  }

  /** Store a 200 body. Best-effort: write failures are logged-and-dropped. */
  async put(url: string, body: Buffer): Promise<void> {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const dest = this.contentPath(url);
      // Unique temp + rename: two compiles racing on the same URL still
      // leave a complete file behind (rename is atomic on same volume).
      const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, dest);
      this.stats.stores += 1;
      this.stats.bytesStored += body.byteLength;
      this.evictIfNeeded(dest);
    } catch {
      // Cache write failure must never break the compile.
    }
  }

  /** Store a 404 marker. Best-effort, same rationale as {@link put}. */
  async putMiss(url: string): Promise<void> {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const dest = this.missPath(url);
      const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.writeFile(tmp, '');
      await fs.promises.rename(tmp, dest);
      this.stats.missStores += 1;
    } catch {
      // Ignore.
    }
  }

  /**
   * Census of the cache directory. Read-only; every error degrades to zeros
   * so the settings UI always has something to render.
   */
  usage(): TexliveCacheUsage {
    const result: TexliveCacheUsage = { binCount: 0, binBytes: 0, missCount: 0 };
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (ENTRY_MISS_RE.test(name)) {
          result.missCount += 1;
          continue;
        }
        if (!ENTRY_BIN_RE.test(name)) continue;
        try {
          result.binBytes += fs.statSync(path.join(this.cacheDir, name)).size;
          result.binCount += 1;
        } catch {
          // Vanished between readdir and stat — skip it.
        }
      }
    } catch {
      // No directory yet (fresh install) — zeros are the honest answer.
    }
    return result;
  }

  /**
   * Drop every cached 404 probe result, keeping the 200 payloads.
   *
   * This is the recovery path for the two cases immutability does not cover:
   * a mirror that has since gained the file, and a CDN that wrongly answered
   * 404. Deleting the `.bin` payloads too would force a multi-tens-of-MB
   * re-download for no benefit, so they are left alone.
   *
   * @returns how many markers were actually unlinked — not how many existed.
   *   Two windows can run this concurrently; the count is this call's work.
   */
  clearMisses(): { removed: number } {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (!ENTRY_MISS_RE.test(name)) continue;
        // Per-file guard: one EPERM (Windows, file held open) must not strip
        // the remaining hundreds.
        try {
          fs.unlinkSync(path.join(this.cacheDir, name));
          removed += 1;
        } catch {
          // Already gone or locked — skip.
        }
      }
    } catch {
      // No directory — nothing to clear.
    }
    return { removed };
  }

  /**
   * LRU eviction: when the directory exceeds maxBytes, delete
   * least-recently-mtime'd entries until back under the cap. Runs inline on
   * put — puts are rare (once per unique URL per machine) so the readdir
   * cost is irrelevant next to the network fetch that preceded it.
   */
  private evictIfNeeded(justWritten: string): void {
    try {
      const names = fs.readdirSync(this.cacheDir);
      const entries: Array<{ file: string; size: number; mtime: number }> = [];
      let total = 0;
      for (const name of names) {
        // `.miss` markers are deliberately NOT eviction candidates. They are
        // zero-byte, so deleting them reclaims nothing, and their mtime is
        // never refreshed (only `.bin` is touched on hit) — which used to
        // sort them first and wipe the whole miss set for no gain, buying a
        // few hundred re-probes on the next compile.
        if (!ENTRY_BIN_RE.test(name)) continue;
        const full = path.join(this.cacheDir, name);
        // Per-entry guard: a file deleted between readdir and stat must not
        // abort the whole eviction pass.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        entries.push({ file: full, size: stat.size, mtime: stat.mtimeMs });
        total += stat.size;
      }
      if (total <= this.maxBytes) return;
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        if (entry.file === justWritten) continue;
        try {
          fs.unlinkSync(entry.file);
          total -= entry.size;
        } catch {
          // Already gone — ignore.
        }
      }
    } catch {
      // Eviction is opportunistic; never fail the put.
    }
  }
}
