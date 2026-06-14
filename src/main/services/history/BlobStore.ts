/**
 * @file BlobStore - filesystem-backed content-addressed blob store.
 *
 * Hashing: SHA-256 via node:crypto. The original plan calls for BLAKE3 (3-5x
 * faster, same 32-byte digest) once a `@noble/hashes`-style dep can be added
 * — `Hash = Uint8Array` is a private detail so the swap is one line in `hash()`
 * with no callsite impact. TODO(blake3): when the dep is in, switch + run the
 * BlobStore suite against both algorithms to confirm hash-stable migration.
 *
 * Storage layout: `{rootDir}/blobs/{hex[0:2]}/{hex}`. Two-hex bucketing spreads
 * blobs across 256 directories so even pathological projects stay below
 * filesystem per-directory limits (NTFS 65k entries, ext4 unlimited but slow).
 *
 * Refcounts live in memory for M2 (a single SQLite migration in M3 moves them
 * to disk along with the blob/chunk/label/step tables). The in-memory map is
 * authoritative until then — `dispose` clears it, so a process restart starts
 * with refcount=0 on every blob, which is fine for the M2 testbench but is the
 * exact reason M3 cannot be deferred past P0.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../LoggerService';
import type { IBlobStore } from './interfaces/IBlobStore';
import type { Hash } from './types';

const logger = createLogger('BlobStore');

export interface BlobStoreOptions {
  /** Absolute path to the per-project history root (`{...}/history/`). */
  rootDir: string;
  /**
   * Bytes below this length skip the disk path entirely. M2 keeps them in the
   * in-memory map; M3 will route them into the SQLite blob row's `bytes`
   * column.
   */
  inlineMaxBytes: number;
}

export class BlobStore implements IBlobStore {
  private readonly blobsDir: string;
  private readonly inlineBlobs = new Map<string, Uint8Array>();
  private readonly refcounts = new Map<string, number>();
  private initialized = false;
  private disposed = false;

  constructor(private readonly opts: BlobStoreOptions) {
    this.blobsDir = path.join(opts.rootDir, 'blobs');
  }

  async put(bytes: Uint8Array): Promise<Hash> {
    this.assertAlive();
    await this.ensureInitialized();

    const hash = hashBytes(bytes);
    const hex = toHex(hash);

    if (bytes.length <= this.opts.inlineMaxBytes) {
      if (!this.inlineBlobs.has(hex)) this.inlineBlobs.set(hex, bytes);
      return hash;
    }

    const target = this.pathFor(hex);
    // Atomic write: hash addresses content, so a half-written file would be
    // indistinguishable from a real one — write to a temp sibling then rename.
    try {
      await fs.access(target);
      return hash;
    } catch {
      // not present
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${this.tempCounter++}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
    return hash;
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    this.assertAlive();
    const hex = toHex(hash);
    const inline = this.inlineBlobs.get(hex);
    if (inline) return inline;
    try {
      const buf = await fs.readFile(this.pathFor(hex));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(hash: Hash): Promise<boolean> {
    this.assertAlive();
    const hex = toHex(hash);
    if (this.inlineBlobs.has(hex)) return true;
    try {
      await fs.access(this.pathFor(hex));
      return true;
    } catch {
      return false;
    }
  }

  async incRef(hash: Hash, by = 1): Promise<void> {
    this.assertAlive();
    const hex = toHex(hash);
    this.refcounts.set(hex, (this.refcounts.get(hex) ?? 0) + by);
  }

  async decRef(hash: Hash, by = 1): Promise<void> {
    this.assertAlive();
    const hex = toHex(hash);
    const current = this.refcounts.get(hex) ?? 0;
    const next = current - by;
    if (next <= 0) this.refcounts.delete(hex);
    else this.refcounts.set(hex, next);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.inlineBlobs.clear();
    this.refcounts.clear();
  }

  /** Test/diagnostics: current refcount for a hash (0 when absent). */
  getRefCount(hash: Hash): number {
    return this.refcounts.get(toHex(hash)) ?? 0;
  }

  // ---- internals ----

  private tempCounter = 0;

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
