/**
 * @file EmbeddingStore — in-memory index + on-disk cache + brute-force cosine
 *   for Zotero paper vectors.
 *
 * Vectors are L2-normalized before insert, so cosine collapses to a dot product
 * for faster search. Brute force on <=5k entries runs <20ms, so we don't pull
 * in FAISS/hnsw (SNACA proved brute force is enough). The whole store is bound
 * to a single modelId (`provider:model`); switching models changes the
 * filename, the old file is ignored, and a rebuild is triggered.
 *
 * bin layout (`embeddings/<modelId-safe>.bin`):
 *   Header 32B: magic u32 'SPEB' | version u32 | dim u32 | count u32 | reserved[16]
 *   Record xN : itemKey 8B (ASCII) | abstractHash 8B (ASCII) | vector dim x f32 LE
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../LoggerService';
import { ZOTERO_CACHE_ROOT } from './ZoteroFullTextService';

const logger = createLogger('EmbeddingStore');

const MAGIC = 0x53504542; // 'SPEB'
const VERSION = 1;
const HEADER_BYTES = 32;
const ITEMKEY_BYTES = 8;
const HASH_BYTES = 8;

/** Embedding cache root: `~/.scipen-studio/zotero-cache/embeddings/` (sibling of parsed). */
export const ZOTERO_EMBEDDING_DIR = path.join(ZOTERO_CACHE_ROOT, 'embeddings');

export interface VectorEntry {
  itemKey: string;
  /** Hash of the abstract text at insert time; abstract changes -> hash changes -> needs re-embedding. */
  abstractHash: string;
  /** L2-normalized vector. */
  vector: Float32Array;
}

/** Replace `:`/`/` etc in modelId with `_` to form a safe filename. Exported for unit tests. */
export function modelIdToFileName(modelId: string): string {
  return `${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.bin`;
}

/** L2 normalize (zero vector returns all-zero). Exported for unit tests. */
export function l2normalize(v: number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Cosine of two **already-normalized** vectors = dot product. Returns 0 on dim mismatch. Exported for unit tests. */
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export class EmbeddingStore {
  private entries = new Map<string, VectorEntry>();
  private modelId: string | null = null;
  private dim = 0;

  getModelId(): string | null {
    return this.modelId;
  }

  size(): number {
    return this.entries.size;
  }

  /** Set the modelId this store is bound to (call before building; if it differs from the loaded file's modelId, clear first). */
  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  /** Guard hit: same itemKey and abstractHash unchanged -> no re-embedding needed. */
  has(itemKey: string, abstractHash: string): boolean {
    const e = this.entries.get(itemKey);
    return e !== undefined && e.abstractHash === abstractHash;
  }

  /** Insert / overwrite one entry (vector must already be normalized). First entry locks the dim. */
  upsert(itemKey: string, abstractHash: string, vector: Float32Array): void {
    if (this.dim === 0) this.dim = vector.length;
    this.entries.set(itemKey, { itemKey, abstractHash, vector });
  }

  remove(itemKey: string): void {
    this.entries.delete(itemKey);
  }

  clear(): void {
    this.entries.clear();
    this.dim = 0;
  }

  /** Brute-force cosine score the entire store (query must be normalized), descending, no truncation.
   *  top3 recommendation takes a prefix; @cite completion semantic rerank consumes the full sequence
   *  — same embedding reused in two places, avoiding a second full scan. */
  scoreAll(query: Float32Array): Array<{ itemKey: string; score: number }> {
    const hits: Array<{ itemKey: string; score: number }> = [];
    for (const e of this.entries.values()) {
      hits.push({ itemKey: e.itemKey, score: cosineNormalized(query, e.vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /** Brute-force cosine top-k (query must be normalized), descending. */
  searchTopK(query: Float32Array, k: number): Array<{ itemKey: string; score: number }> {
    return this.scoreAll(query).slice(0, k);
  }

  private fileFor(modelId: string): string {
    return path.join(ZOTERO_EMBEDDING_DIR, modelIdToFileName(modelId));
  }

  /**
   * Load vectors for the given modelId from disk. File missing / corrupt /
   * magic mismatch -> silently clear (caller decides whether to rebuild
   * based on size()===0). On success, fill the in-memory index and set modelId.
   */
  async loadFromDisk(modelId: string): Promise<void> {
    this.clear();
    this.modelId = modelId;
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.fileFor(modelId));
    } catch {
      return; // no cache -> stay empty
    }
    try {
      this.deserialize(buf);
    } catch (err) {
      logger.warn('embedding cache corrupt, will rebuild', { modelId, error: String(err) });
      this.clear();
      this.modelId = modelId;
    }
  }

  /** Flush the in-memory index to disk (atomic: write tmp then rename). */
  async flushToDisk(): Promise<void> {
    if (!this.modelId || this.entries.size === 0) return;
    await fs.mkdir(ZOTERO_EMBEDDING_DIR, { recursive: true });
    const buf = this.serialize();
    const target = this.fileFor(this.modelId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
  }

  // ============================================================
  // Serialization
  // ============================================================

  private serialize(): Buffer {
    const count = this.entries.size;
    const recBytes = ITEMKEY_BYTES + HASH_BYTES + this.dim * 4;
    const buf = Buffer.alloc(HEADER_BYTES + count * recBytes);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(VERSION, 4);
    buf.writeUInt32LE(this.dim, 8);
    buf.writeUInt32LE(count, 12);
    // 16..32 reserved (already 0)

    let off = HEADER_BYTES;
    for (const e of this.entries.values()) {
      writeFixedAscii(buf, e.itemKey, off, ITEMKEY_BYTES);
      off += ITEMKEY_BYTES;
      writeFixedAscii(buf, e.abstractHash, off, HASH_BYTES);
      off += HASH_BYTES;
      for (let i = 0; i < this.dim; i++) {
        buf.writeFloatLE(e.vector[i], off);
        off += 4;
      }
    }
    return buf;
  }

  private deserialize(buf: Buffer): void {
    if (buf.length < HEADER_BYTES) throw new Error('header too short');
    const magic = buf.readUInt32LE(0);
    if (magic !== MAGIC) throw new Error('bad magic');
    const version = buf.readUInt32LE(4);
    if (version !== VERSION) throw new Error(`unsupported version ${version}`);
    const dim = buf.readUInt32LE(8);
    const count = buf.readUInt32LE(12);
    const recBytes = ITEMKEY_BYTES + HASH_BYTES + dim * 4;
    if (buf.length < HEADER_BYTES + count * recBytes) throw new Error('truncated body');

    this.dim = dim;
    let off = HEADER_BYTES;
    for (let r = 0; r < count; r++) {
      const itemKey = readFixedAscii(buf, off, ITEMKEY_BYTES);
      off += ITEMKEY_BYTES;
      const abstractHash = readFixedAscii(buf, off, HASH_BYTES);
      off += HASH_BYTES;
      const vector = new Float32Array(dim);
      for (let i = 0; i < dim; i++) {
        vector[i] = buf.readFloatLE(off);
        off += 4;
      }
      this.entries.set(itemKey, { itemKey, abstractHash, vector });
    }
  }
}

/** Write fixed-length ASCII (right-pad with \0; truncate if too long). */
function writeFixedAscii(buf: Buffer, str: string, offset: number, len: number): void {
  for (let i = 0; i < len; i++) {
    buf.writeUInt8(i < str.length ? str.charCodeAt(i) & 0x7f : 0, offset + i);
  }
}

/** Read fixed-length ASCII (strip trailing \0). */
function readFixedAscii(buf: Buffer, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf.readUInt8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
