/**
 * @file EmbeddingStore —— Zotero 文献向量的内存索引 + 磁盘缓存 + 暴力 cosine。
 *
 * 向量入库前 L2 归一化 → cosine 退化为点积,搜索更快。≤5k 条暴力搜索 <20ms,
 * 不引入 FAISS/hnsw(SNACA 已验证暴力够用)。整个 store 绑定单一 modelId
 * (`provider:model`),换模型 → 文件名变 → 旧文件被忽略 → 触发重建。
 *
 * bin 布局(`embeddings/<modelId-safe>.bin`):
 *   Header 32B: magic u32 'SPEB' | version u32 | dim u32 | count u32 | reserved[16]
 *   Record×N : itemKey 8B(ASCII) | abstractHash 8B(ASCII) | vector dim×f32 LE
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

/** embedding 缓存根:`~/.scipen-studio/zotero-cache/embeddings/`(与 parsed 同级)。 */
export const ZOTERO_EMBEDDING_DIR = path.join(ZOTERO_CACHE_ROOT, 'embeddings');

export interface VectorEntry {
  itemKey: string;
  /** 入库时摘要文本的 hash;摘要变 → hash 变 → 需重 embed。 */
  abstractHash: string;
  /** 已 L2 归一化的向量。 */
  vector: Float32Array;
}

/** 把 modelId 里的 `:`/`/` 等替成 `_`,作安全文件名。导出供单测。 */
export function modelIdToFileName(modelId: string): string {
  return `${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.bin`;
}

/** L2 归一化(零向量返回全 0)。导出供单测。 */
export function l2normalize(v: number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** 两个**已归一化**向量的 cosine = 点积。维度不等返回 0。导出供单测。 */
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

  /** 设定当前 store 绑定的 modelId(建库前调用;与已加载文件 modelId 不符则应先 clear)。 */
  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  /** 守卫命中:同 itemKey 且 abstractHash 未变 → 无需重 embed。 */
  has(itemKey: string, abstractHash: string): boolean {
    const e = this.entries.get(itemKey);
    return e !== undefined && e.abstractHash === abstractHash;
  }

  /** 写入 / 覆盖一条(向量须已归一化)。首条确定维度。 */
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

  /** cosine 暴力打分全库(query 须已归一化),降序,不截断。top3 推荐取前缀,
   *  @cite 补全语义重排消费完整序——同一次嵌入两处复用,避免二次全库扫描。 */
  scoreAll(query: Float32Array): Array<{ itemKey: string; score: number }> {
    const hits: Array<{ itemKey: string; score: number }> = [];
    for (const e of this.entries.values()) {
      hits.push({ itemKey: e.itemKey, score: cosineNormalized(query, e.vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /** cosine 暴力 top-k(query 须已归一化),降序。 */
  searchTopK(query: Float32Array, k: number): Array<{ itemKey: string; score: number }> {
    return this.scoreAll(query).slice(0, k);
  }

  private fileFor(modelId: string): string {
    return path.join(ZOTERO_EMBEDDING_DIR, modelIdToFileName(modelId));
  }

  /**
   * 从磁盘加载指定 modelId 的向量。文件不存在 / 损坏 / magic 不符 → 静默清空
   * (调用方据 size()===0 决定是否重建)。成功则填充内存索引并设 modelId。
   */
  async loadFromDisk(modelId: string): Promise<void> {
    this.clear();
    this.modelId = modelId;
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.fileFor(modelId));
    } catch {
      return; // 无缓存 → 留空
    }
    try {
      this.deserialize(buf);
    } catch (err) {
      logger.warn('embedding cache corrupt, will rebuild', { modelId, error: String(err) });
      this.clear();
      this.modelId = modelId;
    }
  }

  /** 把当前内存索引写盘(原子:先写 tmp 再 rename)。 */
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
  // 序列化
  // ============================================================

  private serialize(): Buffer {
    const count = this.entries.size;
    const recBytes = ITEMKEY_BYTES + HASH_BYTES + this.dim * 4;
    const buf = Buffer.alloc(HEADER_BYTES + count * recBytes);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(VERSION, 4);
    buf.writeUInt32LE(this.dim, 8);
    buf.writeUInt32LE(count, 12);
    // 16..32 reserved(已是 0)

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

/** 写定长 ASCII(右侧补 \0;超长截断)。 */
function writeFixedAscii(buf: Buffer, str: string, offset: number, len: number): void {
  for (let i = 0; i < len; i++) {
    buf.writeUInt8(i < str.length ? str.charCodeAt(i) & 0x7f : 0, offset + i);
  }
}

/** 读定长 ASCII(去尾部 \0)。 */
function readFixedAscii(buf: Buffer, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf.readUInt8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
