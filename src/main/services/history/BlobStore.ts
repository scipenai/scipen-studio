/**
 * @file BlobStore - filesystem + SQLite content-addressed blob store.
 *
 * Hashing: SHA-256 via node:crypto. The original plan calls for BLAKE3 (3-5x
 * faster, same 32-byte digest) once a `@noble/hashes`-style dep can be added
 * — `Hash = Uint8Array` is a private detail so the swap is one line in `hash()`
 * with no callsite impact. TODO(blake3): when the dep is in, run the BlobStore
 * suite against both algorithms to confirm hash-stable migration.
 *
 * Storage layout: `{rootDir}/blobs/{hex[0:2]}/{hex}` for blobs above the inline
 * threshold; smaller blobs live inline in `history_blob.bytes`. Two-hex
 * bucketing spreads disk blobs across 256 directories so even pathological
 * projects stay below filesystem per-directory limits.
 *
 * Refcounts now live in SQLite (history_blob.refcount). M2 used an in-memory
 * map; M3 moves it to disk so refcount survives process restarts. The same
 * row tracks `size`, `created_at`, and (for inline blobs) `bytes` directly.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { createLogger } from '../LoggerService';
import type { IBlobStore } from './interfaces/IBlobStore';
import type { MetaDb, SqliteDatabase } from './MetaDb';
import type { Hash } from './types';

/** Local alias to keep call-sites readable. */
type Stmt = StatementSync;

const logger = createLogger('BlobStore');

export interface BlobStoreOptions {
  /** Absolute path to the per-project history root (`{...}/history/`). */
  rootDir: string;
  /**
   * Bytes at or below this length skip the disk path and live in
   * `history_blob.bytes`. Matches the planned 4KB SQLite page size by default.
   */
  inlineMaxBytes: number;
  /** Persistent metadata + refcount store. */
  metaDb: MetaDb;
}

export class BlobStore implements IBlobStore {
  private readonly blobsDir: string;
  private initialized = false;
  private disposed = false;
  private tempCounter = 0;

  // Prepared statements stay cached on `BlobStore` — keeping them here avoids
  // polluting MetaDb with domain-specific SQL.
  private readonly stmts: {
    insertBlob: Stmt;
    getBlob: Stmt;
    getRefCount: Stmt;
    incRef: Stmt;
    decRef: Stmt;
    deleteOrphan: Stmt;
  };

  constructor(private readonly opts: BlobStoreOptions) {
    this.blobsDir = path.join(opts.rootDir, 'blobs');
    const db = opts.metaDb.db;
    this.stmts = {
      // OR IGNORE: content-addressed → identical inputs collide intentionally.
      insertBlob: db.prepare(
        'INSERT OR IGNORE INTO history_blob (hash, bytes, size, refcount, created_at) VALUES (?, ?, ?, 0, ?)'
      ),
      getBlob: db.prepare('SELECT bytes, size FROM history_blob WHERE hash = ?'),
      getRefCount: db.prepare('SELECT refcount FROM history_blob WHERE hash = ?'),
      incRef: db.prepare('UPDATE history_blob SET refcount = refcount + ? WHERE hash = ?'),
      decRef: db.prepare(
        // CASE clamps to 0 so a misbalanced caller can't drive refcount negative.
        'UPDATE history_blob SET refcount = CASE WHEN refcount - ? < 0 THEN 0 ELSE refcount - ? END WHERE hash = ?'
      ),
      deleteOrphan: db.prepare('DELETE FROM history_blob WHERE hash = ? AND refcount <= 0'),
    };
    void this.opts as unknown as SqliteDatabase; // keep SqliteDatabase typed-imported for downstream consumers
  }

  async put(bytes: Uint8Array): Promise<Hash> {
    this.assertAlive();
    await this.ensureInitialized();

    const hash = hashBytes(bytes);

    if (bytes.length <= this.opts.inlineMaxBytes) {
      this.stmts.insertBlob.run(hash, bytes, bytes.length, Date.now());
      return hash;
    }

    const hex = toHex(hash);
    const target = this.pathFor(hex);
    try {
      await fs.access(target);
    } catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}-${this.tempCounter++}`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, target);
    }
    // Disk blob — bytes column NULL; the metadata row is what makes refcount
    // and existence queries cheap.
    this.stmts.insertBlob.run(hash, null, bytes.length, Date.now());
    return hash;
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    this.assertAlive();
    const row = this.stmts.getBlob.get(hash) as
      | { bytes: Uint8Array | null; size: number }
      | undefined;
    if (!row) return null;
    if (row.bytes) return new Uint8Array(row.bytes);
    try {
      const buf = await fs.readFile(this.pathFor(toHex(hash)));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(hash: Hash): Promise<boolean> {
    this.assertAlive();
    return this.stmts.getRefCount.get(hash) !== undefined;
  }

  async incRef(hash: Hash, by = 1): Promise<void> {
    this.assertAlive();
    this.stmts.incRef.run(by, hash);
  }

  async decRef(hash: Hash, by = 1): Promise<void> {
    this.assertAlive();
    this.stmts.decRef.run(by, by, hash);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
  }

  /** Test/diagnostics: current refcount for a hash (0 when row absent). */
  getRefCount(hash: Hash): number {
    const row = this.stmts.getRefCount.get(hash) as { refcount: number } | undefined;
    return row?.refcount ?? 0;
  }

  /**
   * Drop the metadata row for an orphan blob (refcount <= 0). The on-disk file
   * itself is left to `sweepOrphans` — single-row prune stays cheap for tests
   * and unit invariants.
   */
  pruneOrphan(hash: Hash): boolean {
    this.assertAlive();
    const result = this.stmts.deleteOrphan.run(hash);
    return result.changes > 0;
  }

  /**
   * Batch sweep: drop every blob row whose `refcount <= 0 AND created_at <
   * cutoff_ms_ago`, then delete the matching on-disk file. The age guard
   * protects in-flight writes — a freshly inserted blob has refcount=0 between
   * `put` and the dependent `incRef`, and getting reaped mid-transaction would
   * lose data.
   *
   * Returns how many rows/files were dropped. Best-effort: filesystem unlink
   * failures are logged and the row is removed regardless (worst case the
   * file lingers but is unreachable).
   */
  async sweepOrphans(minAgeMs = 24 * 60 * 60 * 1000): Promise<{ rows: number; files: number }> {
    this.assertAlive();
    const cutoff = Date.now() - minAgeMs;
    const db = this.opts.metaDb.db;
    const selectStmt = db.prepare(
      'SELECT hash, bytes FROM history_blob WHERE refcount <= 0 AND created_at < ?'
    );
    const deleteStmt = db.prepare('DELETE FROM history_blob WHERE hash = ?');
    const candidates = selectStmt.all(cutoff) as Array<{
      hash: Uint8Array;
      bytes: Uint8Array | null;
    }>;

    let files = 0;
    for (const row of candidates) {
      // Inline blobs (bytes != NULL) carry no separate on-disk file.
      if (!row.bytes) {
        const hex = toHex(new Uint8Array(row.hash));
        try {
          await fs.unlink(this.pathFor(hex));
          files++;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('blob unlink failed', { hex, error: (err as Error).message });
          }
        }
      }
      deleteStmt.run(row.hash);
    }
    return { rows: candidates.length, files };
  }

  // ---- internals ----

  private pathFor(hex: string): string {
    return path.join(this.blobsDir, hex.slice(0, 2), hex);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.blobsDir, { recursive: true });
    this.initialized = true;
    logger.debug('BlobStore initialized', { rootDir: this.opts.rootDir });
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('BlobStore has been disposed');
  }
}

export function createBlobStore(opts: BlobStoreOptions): BlobStore {
  return new BlobStore(opts);
}

function hashBytes(bytes: Uint8Array): Hash {
  // node:crypto returns Buffer; copy into a fresh Uint8Array so the caller
  // can store/compare/serialize without leaking the Node Buffer subtype.
  const digest = createHash('sha256').update(bytes).digest();
  return new Uint8Array(digest);
}

function toHex(hash: Hash): string {
  let out = '';
  for (let i = 0; i < hash.length; i++) out += hash[i].toString(16).padStart(2, '0');
  return out;
}
