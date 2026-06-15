/**
 * @file HistoryService unit tests.
 *
 * Covers L1 (chunk + label + resolveLabelSnapshot) and L2 (step + session DAG)
 * including the transactional refcount invariant and the deterministic step
 * hash.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, createBlobStore } from '../../../../src/main/services/history/BlobStore';
import { HistoryService, createHistoryService } from '../../../../src/main/services/history/HistoryService';
import { MetaDb, createMetaDb } from '../../../../src/main/services/history/MetaDb';

let tmpRoot: string;
let metaDb: MetaDb;
let blobStore: BlobStore;
let svc: HistoryService;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(bs: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bs.length; i++) out += bs[i].toString(16).padStart(2, '0');
  return out;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-history-'));
  metaDb = createMetaDb({ rootDir: tmpRoot });
  blobStore = createBlobStore({ rootDir: tmpRoot, inlineMaxBytes: 16, metaDb });
  svc = createHistoryService({ metaDb, blobStore });
});

afterEach(async () => {
  await svc.dispose();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('HistoryService - L1 chunks', () => {
  it('records a chunk and returns hex hashes + autoincrement id', async () => {
    const r1 = await svc.recordChunk({
      projectId: 'p1',
      fileId: 'main.tex',
      versionFrom: 0,
      versionTo: 10,
      baseContent: bytes('hello'),
      targetContent: bytes('hello world'),
      opCount: 5,
      primaryActor: 'alice',
    });
    expect(r1.chunkId).toBeGreaterThan(0);
    expect(r1.baseBlob).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.targetBlob).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.baseBlob).not.toBe(r1.targetBlob);

    const r2 = await svc.recordChunk({
      projectId: 'p1',
      fileId: 'main.tex',
      versionFrom: 10,
      versionTo: 20,
      baseContent: bytes('hello world'),
      targetContent: bytes('hello world!'),
      opCount: 3,
      primaryActor: 'alice',
    });
    expect(r2.chunkId).toBe(r1.chunkId + 1);
    expect(r2.baseBlob).toBe(r1.targetBlob);
  });

  it('listChunks orders by version_to DESC', async () => {
    for (let i = 0; i < 3; i++) {
      await svc.recordChunk({
        projectId: 'p1',
        fileId: 'main.tex',
        versionFrom: i * 10,
        versionTo: i * 10 + 10,
        baseContent: bytes(`v${i}`),
        targetContent: bytes(`v${i + 1}`),
        opCount: 1,
        primaryActor: null,
      });
    }
    const chunks = await svc.listChunks('p1', 'main.tex');
    expect(chunks.length).toBe(3);
    expect(chunks[0].versionTo).toBe(30);
    expect(chunks[1].versionTo).toBe(20);
    expect(chunks[2].versionTo).toBe(10);
  });

  it('mergeChunks collapses contiguous chunks while preserving end blobs', async () => {
    // Build 5 chunks v0→1, 1→2, 2→3, 3→4, 4→5 on file `m.tex`.
    let prev = bytes('seed');
    const targets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = bytes(`step-${i + 1}`);
      const r = await svc.recordChunk({
        projectId: 'pm',
        fileId: 'm.tex',
        versionFrom: i,
        versionTo: i + 1,
        baseContent: prev,
        targetContent: next,
        opCount: 2,
        primaryActor: null,
      });
      targets.push(r.targetBlob);
      prev = next;
    }
    // minChunks=1 ⇒ collapse if more than 1 chunk exists
    const result = await svc.mergeChunks('pm', 'm.tex', 1);
    expect(result.merged).toBe(4);
    const chunks = await svc.listChunks('pm', 'm.tex');
    expect(chunks.length).toBe(1);
    expect(chunks[0].versionFrom).toBe(0);
    expect(chunks[0].versionTo).toBe(5);
    expect(chunks[0].opCount).toBe(10);
    // Final target blob unchanged
    expect(hexToBytes(targets[targets.length - 1]).join(',')).toBe(
      Array.from(chunks[0].targetBlob).join(',')
    );
  });

  it('mergeChunks no-ops below the threshold', async () => {
    await svc.recordChunk({
      projectId: 'pm2',
      fileId: 'x.tex',
      versionFrom: 0,
      versionTo: 1,
      baseContent: bytes('a'),
      targetContent: bytes('b'),
      opCount: 1,
      primaryActor: null,
    });
    const result = await svc.mergeChunks('pm2', 'x.tex', 10);
    expect(result.merged).toBe(0);
    const chunks = await svc.listChunks('pm2', 'x.tex');
    expect(chunks.length).toBe(1);
  });

  it('refcount accumulates across chained chunks', async () => {
    const r1 = await svc.recordChunk({
      projectId: 'p1',
      fileId: 'a.tex',
      versionFrom: 0,
      versionTo: 1,
      baseContent: bytes('A'),
      targetContent: bytes('AB'),
      opCount: 1,
      primaryActor: null,
    });
    const r2 = await svc.recordChunk({
      projectId: 'p1',
      fileId: 'a.tex',
      versionFrom: 1,
      versionTo: 2,
      baseContent: bytes('AB'),
      targetContent: bytes('ABC'),
      opCount: 1,
      primaryActor: null,
    });
    // 'AB' is both r1.target and r2.base → refcount = 2
    const sharedHash = hexToBytes(r1.targetBlob);
    expect(blobStore.getRefCount(sharedHash)).toBe(2);
    void r2;
  });
});

describe('HistoryService - L1 labels', () => {
  it('createLabel + listLabels + resolveLabelSnapshot round-trip', async () => {
    const base = bytes('abstract: ...');
    const baseHash = await blobStore.put(base);
    const label = await svc.createLabel({
      projectId: 'p1',
      name: 'submit-v1',
      description: 'before journal submission',
      kind: 'manual',
      createdBy: 'alice',
      files: [{ fileId: 'main.tex', blobHashHex: toHex(baseHash), version: 1 }],
    });
    expect(label.id).toBeTruthy();
    expect(label.kind).toBe('manual');

    const labels = await svc.listLabels('p1');
    expect(labels.length).toBe(1);
    expect(labels[0].name).toBe('submit-v1');
    expect(labels[0].description).toBe('before journal submission');

    const snapshot = await svc.resolveLabelSnapshot(label.id);
    expect(snapshot.size).toBe(1);
    const restored = snapshot.get('main.tex');
    expect(restored).toBeDefined();
    expect(Array.from(restored!)).toEqual(Array.from(base));
  });

  it('createLabel bumps refcount for every referenced blob', async () => {
    const aHash = await blobStore.put(bytes('file a'));
    const bHash = await blobStore.put(bytes('file b'));
    await svc.createLabel({
      projectId: 'p1',
      name: 'multi',
      kind: 'auto',
      createdBy: 'sys',
      files: [
        { fileId: 'a', blobHashHex: toHex(aHash), version: 1 },
        { fileId: 'b', blobHashHex: toHex(bHash), version: 1 },
      ],
    });
    expect(blobStore.getRefCount(aHash)).toBe(1);
    expect(blobStore.getRefCount(bHash)).toBe(1);
  });

  it('listLabels orders by created_at DESC', async () => {
    for (let i = 0; i < 3; i++) {
      await svc.createLabel({
        projectId: 'p1',
        name: `label-${i}`,
        kind: 'manual',
        createdBy: 'alice',
        files: [],
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const labels = await svc.listLabels('p1');
    expect(labels.map((l) => l.name)).toEqual(['label-2', 'label-1', 'label-0']);
  });
});

describe('HistoryService - L2 steps', () => {
  it('records a step deterministically (identical inputs → identical hash)', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: 't1', parentSession: null });
    const fileHash = await blobStore.put(bytes('file content'));
    const tree = [{ fileId: 'main.tex', blobHashHex: toHex(fileHash) }];
    const step1 = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree,
      causes: [{ toolName: 'human_edit', argsJson: '{"op_count":3}' }],
      origin: 'human_edit',
      ts: 1_700_000_000_000,
      sizeDelta: 12,
    });
    const step2 = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree,
      causes: [{ toolName: 'human_edit', argsJson: '{"op_count":3}' }],
      origin: 'human_edit',
      ts: 1_700_000_000_000,
      sizeDelta: 12,
    });
    expect(toHex(step1.hash)).toBe(toHex(step2.hash));
  });

  it('different ts → different hash', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const fileHash = await blobStore.put(bytes('content'));
    const tree = [{ fileId: 'main.tex', blobHashHex: toHex(fileHash) }];
    const a = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree,
      causes: [],
      origin: 'snaca_tool',
      ts: 1,
      sizeDelta: 0,
    });
    const b = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree,
      causes: [],
      origin: 'snaca_tool',
      ts: 2,
      sizeDelta: 0,
    });
    expect(toHex(a.hash)).not.toBe(toHex(b.hash));
  });

  it('getStep returns the same row recordStep wrote', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const fileHash = await blobStore.put(bytes('x'));
    const written = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree: [{ fileId: 'a', blobHashHex: toHex(fileHash) }],
      causes: [{ toolName: 'Bash', argsJson: '{"command":"ls"}' }],
      origin: 'snaca_tool',
      ts: 42,
      sizeDelta: 1,
    });
    const round = await svc.getStep(toHex(written.hash));
    expect(round).not.toBeNull();
    expect(round!.origin).toBe('snaca_tool');
    expect(round!.ts).toBe(42);
    expect(round!.sizeDelta).toBe(1);
  });

  it('listSessionSteps orders by ts ASC', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const fileHash = await blobStore.put(bytes('x'));
    const tree = [{ fileId: 'a', blobHashHex: toHex(fileHash) }];
    for (const ts of [30, 10, 20]) {
      await svc.recordStep({
        projectId: 'p1',
        sessionId: 's1',
        parentStepHashHex: null,
        tree,
        causes: [{ toolName: 'ts-' + ts }],
        origin: 'human_edit',
        ts,
        sizeDelta: 0,
      });
    }
    const steps = await svc.listSessionSteps('s1');
    expect(steps.map((s) => s.ts)).toEqual([10, 20, 30]);
  });

  it('recordStep refcounts: tree blob +1, every file blob +1', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const aHash = await blobStore.put(bytes('a'));
    const bHash = await blobStore.put(bytes('b'));
    const result = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree: [
        { fileId: 'a', blobHashHex: toHex(aHash) },
        { fileId: 'b', blobHashHex: toHex(bHash) },
      ],
      causes: [],
      origin: 'human_edit',
      ts: 1,
      sizeDelta: 0,
    });
    expect(blobStore.getRefCount(aHash)).toBe(1);
    expect(blobStore.getRefCount(bHash)).toBe(1);
    expect(blobStore.getRefCount(result.treeHash)).toBe(1);
  });

  it('resolveStepSnapshot returns file → bytes from the step tree', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const aHash = await blobStore.put(bytes('alpha contents'));
    const bHash = await blobStore.put(bytes('bravo contents'));
    const step = await svc.recordStep({
      projectId: 'p1',
      sessionId: 's1',
      parentStepHashHex: null,
      tree: [
        { fileId: 'a.tex', blobHashHex: toHex(aHash) },
        { fileId: 'b.tex', blobHashHex: toHex(bHash) },
      ],
      causes: [],
      origin: 'human_edit',
      ts: 1,
      sizeDelta: 0,
    });
    const snap = await svc.resolveStepSnapshot(toHex(step.hash));
    expect(snap.size).toBe(2);
    expect(new TextDecoder().decode(snap.get('a.tex')!)).toBe('alpha contents');
    expect(new TextDecoder().decode(snap.get('b.tex')!)).toBe('bravo contents');
  });

  it('findStepBeforeTs returns the latest step strictly before the cutoff', async () => {
    svc.ensureSession({ id: 's1', projectId: 'p1', chatThreadId: null, parentSession: null });
    const fileHash = await blobStore.put(bytes('x'));
    const tree = [{ fileId: 'a', blobHashHex: toHex(fileHash) }];
    for (const ts of [10, 20, 30]) {
      await svc.recordStep({
        projectId: 'p1',
        sessionId: 's1',
        parentStepHashHex: null,
        tree,
        causes: [{ toolName: `t-${ts}` }],
        origin: 'human_edit',
        ts,
        sizeDelta: 0,
      });
    }
    const at25 = await svc.findStepBeforeTs('s1', 25);
    expect(at25?.ts).toBe(20);
    const at10 = await svc.findStepBeforeTs('s1', 10);
    expect(at10).toBeNull();
    const at100 = await svc.findStepBeforeTs('s1', 100);
    expect(at100?.ts).toBe(30);
  });

  it('step FK fails if session row absent (transaction rolls back)', async () => {
    const fileHash = await blobStore.put(bytes('content'));
    await expect(
      svc.recordStep({
        projectId: 'p1',
        sessionId: 'never-existed',
        parentStepHashHex: null,
        tree: [{ fileId: 'a', blobHashHex: toHex(fileHash) }],
        causes: [],
        origin: 'human_edit',
        ts: 1,
        sizeDelta: 0,
      })
    ).rejects.toThrow();
    // File blob refcount must not be bumped because the transaction rolled back.
    expect(blobStore.getRefCount(fileHash)).toBe(0);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
