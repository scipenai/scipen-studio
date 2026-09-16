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
 *   - 200s are cached without TTL: the default endpoint serves an immutable
 *     TeX Live snapshot, and a URL with different content would be a
 *     different endpoint (different key). 404 misses ARE cached (kpathsea
 *     probes produce many miss requests; re-paying those RTTs on every
 *     launch is part of the cold-start cost) but expire after MISS_TTL_MS
 *     so a mirror that later gains the file is re-consulted.
 *   - 5xx / network errors are never cached — `handleTexliveRemote`
 *     deliberately returns 502 so BusyTeX does not record a permanent miss.
 *   - Every cache error is swallowed into a "no cache" outcome: the compile
 *     must succeed exactly as it did before this module existed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Cached 404s expire after this long so late-added files are re-consulted. */
export const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
        if (Date.now() - fs.statSync(missPath).mtimeMs > MISS_TTL_MS) {
          fs.unlinkSync(missPath);
          return null;
        }
        this.stats.missHits += 1;
        return { status: 404, body: null };
      }

      const contentPath = this.contentPath(url);
      if (!fs.existsSync(contentPath)) return null;
      const body = await fs.promises.readFile(contentPath);
      this.stats.hits += 1;
      this.stats.bytesServed += body.byteLength;
      // Refresh mtime so LRU eviction sees this entry as recently used.
      const now = new Date();
      fs.utimesSync(contentPath, now, now);
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
        if (!name.endsWith('.bin') && !name.endsWith('.miss')) continue;
        const full = path.join(this.cacheDir, name);
        const stat = fs.statSync(full);
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
