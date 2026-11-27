/**
 * @file busytex-process/buildArtifactCache.ts — build artifacts carried between compiles
 *
 * TeX converges through its own artifacts: a compile that starts from the
 * previous run's .aux/.toc/.out usually needs ONE pass, one that starts cold
 * needs two or three. The engine rebuilds its virtual FS from scratch on
 * every compile (so deleted sources never linger), and this cache feeds the
 * last clean run's artifacts back in.
 *
 * Memory first, disk behind it, so an idle-released engine process or an app
 * restart still compiles warm. Every disk failure degrades to "no cache" —
 * a cache must never be the reason a compile fails.
 *
 * Pure Node (no electron): the main process uses it too, to clear the
 * directory while no engine process is running.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import * as nodePath from 'node:path';

/** Bump when the stored shape or what counts as an artifact changes. */
const SCHEMA_VERSION = 1;
const ENTRY_SUFFIX = '.json';
const WARM_PACKAGES_FILE = 'warm-packages.json';
/** Projects remembered for data-package prewarming. */
const MAX_WARM_PROJECTS = 20;

export interface CachedArtifact {
  /** Project-relative, `/`-separated. */
  path: string;
  bytes: Uint8Array;
}

export interface ArtifactKeyInput {
  /** Project root, or the output dir for a file outside any project. */
  root: string;
  /** Staged name of the main file. */
  mainFile: string;
  driver: string;
  /** BusyTeX asset version — a different TeX Live may write different aux. */
  assetVersion: string;
  /** Different endpoints can serve different package snapshots. */
  endpoint: string;
}

export interface CacheLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: CacheLimits = { maxEntries: 100, maxTotalBytes: 200 * 1024 * 1024 };

interface StoredEntry {
  v: number;
  savedAt: number;
  artifacts: Array<{ path: string; b64: string }>;
}

/** Normalised root: one spelling per directory, case-folded where the FS is. */
export function normaliseRoot(
  root: string,
  caseInsensitive = process.platform === 'win32'
): string {
  const resolved = nodePath.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/**
 * A stored path is written into the engine's virtual FS, so a corrupted or
 * tampered entry must not be able to reach outside the project dir there.
 */
export function isSafeArtifactPath(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((segment) => segment === '..' || segment === '');
}

function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Windows: an AV scanner can hold the target for a moment. One retry,
    // then give up — the cache is an optimisation.
    try {
      fs.renameSync(tmp, target);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
}

export class BuildArtifactCache {
  private readonly memory = new Map<string, CachedArtifact[]>();
  /** First-error signature of the last cold retry that still failed, per key. */
  private readonly coldFailures = new Map<string, string | null>();

  constructor(
    /** Empty string = memory only (no persistence). */
    private readonly dir: string,
    private readonly limits: CacheLimits = DEFAULT_LIMITS
  ) {}

  key(input: ArtifactKeyInput): string {
    const material = JSON.stringify([
      SCHEMA_VERSION,
      normaliseRoot(input.root),
      input.mainFile,
      input.driver,
      input.assetVersion,
      input.endpoint,
    ]);
    return createHash('sha256').update(material).digest('hex');
  }

  get(key: string): CachedArtifact[] | null {
    const hit = this.memory.get(key);
    if (hit) return hit;
    const fromDisk = this.readEntry(key);
    if (fromDisk) this.memory.set(key, fromDisk);
    return fromDisk;
  }

  /** Store the artifacts of a CLEAN compile; callers never pass a failed run's. */
  put(key: string, artifacts: CachedArtifact[]): void {
    const safe = artifacts.filter((a) => isSafeArtifactPath(a.path));
    this.memory.set(key, safe);
    this.coldFailures.delete(key);
    if (!this.dir) return;
    try {
      const entries = nodePath.join(this.dir, 'entries');
      fs.mkdirSync(entries, { recursive: true });
      const stored: StoredEntry = {
        v: SCHEMA_VERSION,
        savedAt: Date.now(),
        artifacts: safe.map((a) => ({
          path: a.path,
          b64: Buffer.from(a.bytes).toString('base64'),
        })),
      };
      writeAtomic(nodePath.join(entries, `${key}${ENTRY_SUFFIX}`), JSON.stringify(stored));
      this.prune(entries);
    } catch {
      // Disk full, read-only profile, … — the memory copy still serves.
    }
  }

  /** The remembered "cold retry failed with this error too" signature, if any. */
  coldFailure(key: string): string | null | undefined {
    return this.coldFailures.has(key) ? (this.coldFailures.get(key) ?? null) : undefined;
  }

  recordColdFailure(key: string, signature: string | null): void {
    this.coldFailures.set(key, signature);
  }

  /** Data packages this project needed last time, for the next prewarm. */
  warmPackages(root: string): string[] {
    const all = this.readWarm();
    return all[normaliseRoot(root)] ?? [];
  }

  recordPackages(root: string, packages: string[]): void {
    if (!this.dir) return;
    try {
      const all = this.readWarm();
      const key = normaliseRoot(root);
      delete all[key];
      // Most recent last; drop the oldest beyond the cap.
      const next: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(all).slice(-(MAX_WARM_PROJECTS - 1))) next[k] = v;
      next[key] = packages;
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(nodePath.join(this.dir, WARM_PACKAGES_FILE), JSON.stringify(next));
    } catch {
      // Prewarming is best-effort.
    }
  }

  /** Drop every stored artifact set (memory and disk). Never throws. */
  clear(): { removed: number } {
    let removed = this.memory.size;
    this.memory.clear();
    this.coldFailures.clear();
    if (!this.dir) return { removed };
    const entries = nodePath.join(this.dir, 'entries');
    let onDisk = 0;
    try {
      for (const name of fs.readdirSync(entries)) {
        if (!name.endsWith(ENTRY_SUFFIX)) continue;
        try {
          fs.unlinkSync(nodePath.join(entries, name));
          onDisk += 1;
        } catch {
          // Locked or already gone — skip.
        }
      }
    } catch {
      // No directory yet.
    }
    removed = Math.max(removed, onDisk);
    return { removed };
  }

  private readEntry(key: string): CachedArtifact[] | null {
    if (!this.dir) return null;
    const file = nodePath.join(this.dir, 'entries', `${key}${ENTRY_SUFFIX}`);
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredEntry;
      if (stored.v !== SCHEMA_VERSION || !Array.isArray(stored.artifacts)) return null;
      // Refresh recency so pruning keeps entries that are actually used.
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch {
        // Recency is bookkeeping; the hit stands.
      }
      return stored.artifacts
        .filter((a) => typeof a.path === 'string' && typeof a.b64 === 'string')
        .filter((a) => isSafeArtifactPath(a.path))
        .map((a) => ({ path: a.path, bytes: new Uint8Array(Buffer.from(a.b64, 'base64')) }));
    } catch {
      return null;
    }
  }

  private readWarm(): Record<string, string[]> {
    if (!this.dir) return {};
    try {
      const parsed = JSON.parse(
        fs.readFileSync(nodePath.join(this.dir, WARM_PACKAGES_FILE), 'utf8')
      ) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
      }
      return out;
    } catch {
      return {};
    }
  }

  /** LRU by mtime: keep under both the entry-count and the byte cap. */
  private prune(entries: string): void {
    const files = fs
      .readdirSync(entries)
      .filter((name) => name.endsWith(ENTRY_SUFFIX))
      .flatMap((name) => {
        const full = nodePath.join(entries, name);
        try {
          const st = fs.statSync(full);
          return [{ full, size: st.size, mtime: st.mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    files.forEach((file, index) => {
      total += file.size;
      if (index >= this.limits.maxEntries || total > this.limits.maxTotalBytes) {
        try {
          fs.unlinkSync(file.full);
        } catch {
          // Already gone.
        }
      }
    });
  }
}
