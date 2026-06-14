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
import type Database from 'better-sqlite3';
import { createLogger } from '../LoggerService';
import type { IBlobStore } from './interfaces/IBlobStore';
import type { MetaDb } from './MetaDb';
import type { Hash } from './types';

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
  // polluting MetaDb with domain-specific SQL. Generic `unknown[]` bind tuple
  // because better-sqlite3's default conditional type otherwise collapses to a
  // zero-arity signature.
  private readonly stmts: {
    insertBlob: Database.Statement<unknown[]>;
    getBlob: Database.Statement<unknown[]>;
    getRefCount: Database.Statement<unknown[]>;
    incRef: Database.Statement<unknown[]>;
    decRef: Database.Statement<unknown[]>;
    deleteOrphan: Database.Statement<unknown[]>;
  };

  constructor(private readonly opts: BlobStoreOptions) {
    this.blobsDir = path.join(opts.rootDir, 'blobs');
    const db = opts.metaDb.db;
    this.stmts = {
      // OR IGNORE: content-addressed → identical inputs collide intentionally.
      insertBlob: db.prepare<unknown[]>(
        'INSERT OR IGNORE INTO history_blob (hash, bytes, size, refcount, created_at) VALUES (?, ?, ?, 0, ?)'
      ),
      getBlob: db.prepare<unknown[]>('SELECT bytes, size FROM history_blob WHERE hash = ?'),
      getRefCount: db.prepare<unknown[]>('SELECT refcount FROM history_blob WHERE hash = ?'),
      incRef: db.prepare<unknown[]>(
        'UPDATE history_blob SET refcount = refcount + ? WHERE hash = ?'
      ),
      decRef: db.prepare<unknown[]>(
        // CASE clamps to 0 so a misbalanced caller can't drive refcount negative.
        'UPDATE history_blob SET refcount = CASE WHEN refcount - ? < 0 THEN 0 ELSE refcount - ? END WHERE hash = ?'
      ),
      deleteOrphan: db.prepare<unknown[]>(
        'DELETE FROM history_blob WHERE hash = ? AND refcount <= 0'
      ),
    };
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
    const row = this.stmts.getBlob.get(hash) as { bytes: Uint8Array | null; size: number } | undefined;
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
   * itself is left to the GC sweep (M4) — production sweeps are batched, but
   * tests rely on this hook to verify the SQL clamp behaviour.
   */
  pruneOrphan(hash: Hash): boolean {
    this.assertAlive();
    const result = this.stmts.deleteOrphan.run(hash);
    return result.changes > 0;
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
