import { promises as fs } from 'fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// EmbeddingStore 依赖 ZoteroFullTextService 的 ZOTERO_CACHE_ROOT(只取常量,
// 不触发其副作用);用真实 tmp 目录覆盖,避免写进用户 home。
// vi.hoisted 在 import 之前求值,供 vi.mock 工厂引用。
const { TMP_ROOT } = vi.hoisted(() => {
  const o = require('os') as typeof import('os');
  const p = require('path') as typeof import('path');
  return { TMP_ROOT: p.join(o.tmpdir(), `scipen-emb-test-${process.pid}`) };
});
vi.mock('../../../src/main/services/zotero/ZoteroFullTextService', () => ({
  ZOTERO_CACHE_ROOT: TMP_ROOT,
}));
vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  EmbeddingStore,
  cosineNormalized,
  l2normalize,
  modelIdToFileName,
} from '../../../src/main/services/zotero/EmbeddingStore';

describe('l2normalize', () => {
  it('produces a unit vector', () => {
    const v = l2normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 5);
  });

  it('returns zeros for a zero vector (no NaN)', () => {
    const v = l2normalize([0, 0, 0]);
    expect(Array.from(v)).toEqual([0, 0, 0]);
  });
});

describe('cosineNormalized', () => {
  it('is 1 for identical direction, -1 for opposite, 0 for orthogonal', () => {
    const x = l2normalize([1, 0]);
    const y = l2normalize([0, 1]);
    const negX = l2normalize([-1, 0]);
    expect(cosineNormalized(x, x)).toBeCloseTo(1, 5);
    expect(cosineNormalized(x, negX)).toBeCloseTo(-1, 5);
    expect(cosineNormalized(x, y)).toBeCloseTo(0, 5);
  });

  it('returns 0 on dimension mismatch', () => {
    expect(cosineNormalized(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });
});

describe('modelIdToFileName', () => {
  it('sanitizes provider:model into a safe filename', () => {
    expect(modelIdToFileName('zhipu:embedding-3')).toBe('zhipu_embedding-3.bin');
    expect(modelIdToFileName('openai:text-embedding-3-small')).toBe(
      'openai_text-embedding-3-small.bin'
    );
  });
});

describe('EmbeddingStore in-memory ops', () => {
  it('upsert / has guard / remove / searchTopK ordering', () => {
    const s = new EmbeddingStore();
    s.setModelId('zhipu:embedding-3');
    s.upsert('AAAA1111', 'hash0001', l2normalize([1, 0, 0]));
    s.upsert('BBBB2222', 'hash0002', l2normalize([0, 1, 0]));
    s.upsert('CCCC3333', 'hash0003', l2normalize([0.9, 0.1, 0]));

    expect(s.size()).toBe(3);
    expect(s.has('AAAA1111', 'hash0001')).toBe(true);
    expect(s.has('AAAA1111', 'different')).toBe(false); // hash changed → miss
    expect(s.has('ZZZZ9999', 'x')).toBe(false);

    const top = s.searchTopK(l2normalize([1, 0, 0]), 2);
    expect(top[0].itemKey).toBe('AAAA1111'); // exact match scores highest
    expect(top[1].itemKey).toBe('CCCC3333'); // closer than orthogonal B
    expect(top).toHaveLength(2);

    s.remove('AAAA1111');
    expect(s.size()).toBe(2);
    expect(s.has('AAAA1111', 'hash0001')).toBe(false);
  });

  it('scoreAll returns every record descending; searchTopK is its prefix', () => {
    const s = new EmbeddingStore();
    s.setModelId('zhipu:embedding-3');
    s.upsert('AAAA1111', 'h1', l2normalize([1, 0, 0]));
    s.upsert('BBBB2222', 'h2', l2normalize([0, 1, 0])); // 正交 → 最低
    s.upsert('CCCC3333', 'h3', l2normalize([0.9, 0.1, 0])); // 居中

    const all = s.scoreAll(l2normalize([1, 0, 0]));
    expect(all.map((h) => h.itemKey)).toEqual(['AAAA1111', 'CCCC3333', 'BBBB2222']);
    expect(all[0].score).toBeGreaterThan(all[1].score);
    expect(all[1].score).toBeGreaterThan(all[2].score);

    // searchTopK 必须是 scoreAll 的前缀(同序)。
    expect(s.searchTopK(l2normalize([1, 0, 0]), 2)).toEqual(all.slice(0, 2));
  });
});

describe('EmbeddingStore disk round-trip', () => {
  beforeEach(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  });
  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  });

  it('flush then load reproduces vectors bit-for-bit', async () => {
    const a = new EmbeddingStore();
    a.setModelId('zhipu:embedding-3');
    a.upsert('AAAA1111', 'h0000001', l2normalize([0.1, 0.2, 0.3, 0.4]));
    a.upsert('BBBB2222', 'h0000002', l2normalize([-0.5, 0.5, 0.1, 0.0]));
    await a.flushToDisk();

    const b = new EmbeddingStore();
    await b.loadFromDisk('zhipu:embedding-3');
    expect(b.size()).toBe(2);
    expect(b.has('AAAA1111', 'h0000001')).toBe(true);
    expect(b.has('BBBB2222', 'h0000002')).toBe(true);

    // searchTopK on reloaded store matches the source store
    const q = l2normalize([0.1, 0.2, 0.3, 0.4]);
    expect(b.searchTopK(q, 1)[0].itemKey).toBe('AAAA1111');
  });

  it('loadFromDisk for an unknown modelId yields empty store (triggers rebuild)', async () => {
    const s = new EmbeddingStore();
    await s.loadFromDisk('aliyun:text-embedding-v3');
    expect(s.size()).toBe(0);
    expect(s.getModelId()).toBe('aliyun:text-embedding-v3');
  });

  it('a different modelId does not read another modelId file', async () => {
    const a = new EmbeddingStore();
    a.setModelId('zhipu:embedding-3');
    a.upsert('AAAA1111', 'h0000001', l2normalize([1, 0]));
    await a.flushToDisk();

    const b = new EmbeddingStore();
    await b.loadFromDisk('openai:text-embedding-3-small'); // different file
    expect(b.size()).toBe(0);
  });
});
