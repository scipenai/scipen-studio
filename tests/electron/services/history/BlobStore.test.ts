/**
 * @file BlobStore unit tests.
 *
 * Exercises the content-addressed contract: identical bytes hash to identical
 * digests; round-trip preserves bytes exactly; inline-vs-file path is invisible
 * to callers; refcounts add and subtract symmetrically and clamp at zero;
 * disposal is one-way and idempotent.
 *
 * Each test gets a fresh tmp dir + MetaDb so SQLite state does not leak across
 * cases.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, createBlobStore } from '../../../../src/main/services/history/BlobStore';
import { MetaDb, createMetaDb } from '../../../../src/main/services/history/MetaDb';

let tmpRoot: string;
let metaDb: MetaDb;
let store: BlobStore;

async function newStore(inlineMaxBytes = 16): Promise<BlobStore> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-blobstore-'));
  metaDb = createMetaDb({ rootDir: tmpRoot });
  return createBlobStore({ rootDir: tmpRoot, inlineMaxBytes, metaDb });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

beforeEach(async () => {
  store = await newStore();
});

afterEach(async () => {
  await store.dispose();
  metaDb.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('BlobStore', () => {
  it('round-trips a small (inline) blob exactly', async () => {
    const input = bytes('hello world');
    const hash = await store.put(input);
    const got = await store.get(hash);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual(Array.from(input));
  });

  it('round-trips a large (on-disk) blob exactly', async () => {
    const input = bytes('the quick brown fox jumps over the lazy dog');
    const hash = await store.put(input);
    const got = await store.get(hash);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual(Array.from(input));
  });

  it('returns the same hash for identical bytes (content-addressed)', async () => {
    const a = await store.put(bytes('identical payload to confirm address stability'));
    const b = await store.put(bytes('identical payload to confirm address stability'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns different hashes for different bytes', async () => {
    const a = await store.put(bytes('alpha bravo charlie'));
    const b = await store.put(bytes('alpha bravo charlie!'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('reports has() correctly across inline and disk paths', async () => {
    const small = await store.put(bytes('tiny'));
    const big = await store.put(bytes('this is large enough to spill to disk'));
    expect(await store.has(small)).toBe(true);
    expect(await store.has(big)).toBe(true);
    const ghostHash = new Uint8Array(32);
    expect(await store.has(ghostHash)).toBe(false);
  });

  it('returns null from get() for an unknown hash', async () => {
    const ghostHash = new Uint8Array(32);
    expect(await store.get(ghostHash)).toBeNull();
  });

  it('inc/dec refcounts symmetrically (SQL-clamped at 0)', async () => {
    const hash = await store.put(bytes('refcount target'));
    expect(store.getRefCount(hash)).toBe(0);
    await store.incRef(hash);
    await store.incRef(hash, 2);
    expect(store.getRefCount(hash)).toBe(3);
    await store.decRef(hash);
    expect(store.getRefCount(hash)).toBe(2);
    await store.decRef(hash, 2);
    expect(store.getRefCount(hash)).toBe(0);
  });

  it('decRef below zero clamps in SQL (no negative)', async () => {
    const hash = await store.put(bytes('clamp target'));
    await store.decRef(hash, 5);
    expect(store.getRefCount(hash)).toBe(0);
  });

  it('pruneOrphan removes refcount=0 rows; preserves referenced rows', async () => {
    const orphan = await store.put(bytes('to be pruned'));
    const kept = await store.put(bytes('still referenced'));
    await store.incRef(kept);
    expect(store.pruneOrphan(orphan)).toBe(true);
    expect(await store.has(orphan)).toBe(false);
    expect(store.pruneOrphan(kept)).toBe(false);
    expect(await store.has(kept)).toBe(true);
  });

  it('writes large blobs into the two-hex bucketed layout', async () => {
    const payload = bytes('forced-to-disk content for path layout assertion');
    await store.put(payload);
    const blobsDir = path.join(tmpRoot, 'blobs');
    const buckets = await fs.readdir(blobsDir);
    expect(buckets.length).toBeGreaterThan(0);
    const firstBucket = buckets[0];
    expect(firstBucket).toMatch(/^[0-9a-f]{2}$/);
    const filesIn = await fs.readdir(path.join(blobsDir, firstBucket));
    expect(filesIn.length).toBe(1);
    expect(filesIn[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(filesIn[0].slice(0, 2)).toBe(firstBucket);
  });

  it('refcount survives BlobStore re-construction (SQL-backed)', async () => {
    const hash = await store.put(bytes('survives restart'));
    await store.incRef(hash, 7);
    await store.dispose();
    metaDb.close();
    // Re-open same dir → MetaDb opens existing file, refcount preserved.
    metaDb = createMetaDb({ rootDir: tmpRoot });
    store = createBlobStore({ rootDir: tmpRoot, inlineMaxBytes: 16, metaDb });
    expect(store.getRefCount(hash)).toBe(7);
  });

  it('rejects further calls after dispose', async () => {
    const hash = await store.put(bytes('alive'));
    await store.dispose();
    await expect(store.put(bytes('after dispose'))).rejects.toThrow(/disposed/);
    await expect(store.get(hash)).rejects.toThrow(/disposed/);
  });

  it('dispose is idempotent', async () => {
    await store.dispose();
    await expect(store.dispose()).resolves.toBeUndefined();
  });
});
