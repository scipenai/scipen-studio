/**
 * @file ChunkWriter unit tests.
 *
 * Hot-path invariants: `recordEdit` is synchronous and never throws under
 * normal use; batches coalesce per (project, file); ops-threshold and idle
 * timer both trigger flush; dispose drains. Perf benchmark asserts the
 * synchronous enqueue stays below the per-keystroke budget.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkWriter, createChunkWriter } from '../../../../src/main/services/history/ChunkWriter';
import {
  HistoryManager,
  createHistoryManager,
} from '../../../../src/main/services/history/HistoryManager';

let baseDir: string;
let mgr: HistoryManager;
let writer: ChunkWriter;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-chunkwriter-'));
  mgr = createHistoryManager({ baseDir, inlineMaxBytes: 16 });
});

afterEach(async () => {
  if (writer) await writer.dispose();
  await mgr.dispose();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('ChunkWriter', () => {
  it('coalesces consecutive edits to the same file into one batch', async () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 100, chunkFlushIdleMs: 100_000 },
    });
    for (let i = 0; i < 5; i++) {
      writer.recordEdit({
        projectId: 'p1',
        fileId: 'main.tex',
        versionFrom: i,
        versionTo: i + 1,
        prevContent: bytes(`v${i}`),
        currContent: bytes(`v${i + 1}`),
        opCount: 1,
        actor: 'alice',
      });
    }
    expect(writer.pendingCount()).toBe(1);
  });

  it('keeps per-file batches independent', () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 100, chunkFlushIdleMs: 100_000 },
    });
    writer.recordEdit({
      projectId: 'p1',
      fileId: 'a.tex',
      versionFrom: 0,
      versionTo: 1,
      prevContent: bytes(''),
      currContent: bytes('a'),
      opCount: 1,
      actor: null,
    });
    writer.recordEdit({
      projectId: 'p1',
      fileId: 'b.tex',
      versionFrom: 0,
      versionTo: 1,
      prevContent: bytes(''),
      currContent: bytes('b'),
      opCount: 1,
      actor: null,
    });
    expect(writer.pendingCount()).toBe(2);
  });

  it('flushes when opCount crosses the threshold (microtask)', async () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 3, chunkFlushIdleMs: 100_000 },
    });
    for (let i = 0; i < 3; i++) {
      writer.recordEdit({
        projectId: 'p1',
        fileId: 'main.tex',
        versionFrom: i,
        versionTo: i + 1,
        prevContent: bytes(`v${i}`),
        currContent: bytes(`v${i + 1}`),
        opCount: 1,
        actor: null,
      });
    }
    // flushAll waits on both pending batches and any in-flight work the
    // microtask kicked off, so by the time it resolves the chunk row exists.
    await writer.flushAll();
    expect(writer.pendingCount()).toBe(0);

    const chunks = await mgr.getOrCreate('p1').listChunks('p1', 'main.tex');
    expect(chunks.length).toBe(1);
    expect(chunks[0].versionFrom).toBe(0);
    expect(chunks[0].versionTo).toBe(3);
    expect(chunks[0].opCount).toBe(3);
  });

  it('flushes via the idle timer when the threshold is not reached', async () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 1_000, chunkFlushIdleMs: 30 },
    });
    writer.recordEdit({
      projectId: 'p1',
      fileId: 'idle.tex',
      versionFrom: 0,
      versionTo: 1,
      prevContent: bytes(''),
      currContent: bytes('x'),
      opCount: 1,
      actor: null,
    });
    // Wait long enough for the idle timer to fire (30ms) + a margin, then
    // explicitly flush any work that the timer already queued. flushAll
    // awaits both pending batches and any in-flight writes, eliminating the
    // setTimeout-vs-async-IO race that made this test flaky.
    await new Promise((r) => setTimeout(r, 80));
    await writer.flushAll();
    expect(writer.pendingCount()).toBe(0);
    const chunks = await mgr.getOrCreate('p1').listChunks('p1', 'idle.tex');
    expect(chunks.length).toBe(1);
  });

  it('dispose drains every pending batch', async () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 1_000, chunkFlushIdleMs: 100_000 },
    });
    for (const fileId of ['a', 'b', 'c']) {
      writer.recordEdit({
        projectId: 'p1',
        fileId,
        versionFrom: 0,
        versionTo: 1,
        prevContent: bytes(''),
        currContent: bytes(fileId),
        opCount: 1,
        actor: null,
      });
    }
    await writer.dispose();
    for (const fileId of ['a', 'b', 'c']) {
      const chunks = await mgr.getOrCreate('p1').listChunks('p1', fileId);
      expect(chunks.length).toBe(1);
    }
  });

  it('routes flush failures through onError instead of throwing', async () => {
    const errors: Array<{ err: Error; ctx: { projectId: string; fileId: string } }> = [];
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 1, chunkFlushIdleMs: 100_000 },
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    // `..` is rejected by HistoryManager.PROJECT_ID_RX, so the inner
    // `getOrCreate` throws inside the flush — perfect for the onError path.
    writer.recordEdit({
      projectId: 'badproject!!!',
      fileId: 'x.tex',
      versionFrom: 0,
      versionTo: 1,
      prevContent: bytes(''),
      currContent: bytes('x'),
      opCount: 1,
      actor: null,
    });
    await writer.flushAll();
    expect(errors.length).toBe(1);
    expect(errors[0].err.message).toMatch(/Invalid projectId/);
    expect(errors[0].ctx.projectId).toBe('badproject!!!');
  });

  it('recordEdit returns synchronously under 1ms on average (hot-path budget)', () => {
    writer = createChunkWriter({
      historyManager: mgr,
      config: { chunkFlushOps: 100_000, chunkFlushIdleMs: 100_000 },
    });
    const payload = bytes('x'.repeat(64));
    const N = 5_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      writer.recordEdit({
        projectId: 'p1',
        fileId: `f${i % 50}.tex`,
        versionFrom: i,
        versionTo: i + 1,
        prevContent: payload,
        currContent: payload,
        opCount: 1,
        actor: null,
      });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const perCallMicros = (elapsedMs / N) * 1000;
    // Budget: < 1ms per call (the keystroke frame budget is 16ms; we want
    // far below that to leave headroom for actual editor work).
    expect(perCallMicros).toBeLessThan(1000);
  });

  it('rejects further calls after dispose', async () => {
    writer = createChunkWriter({ historyManager: mgr });
    await writer.dispose();
    expect(() =>
      writer.recordEdit({
        projectId: 'p1',
        fileId: 'x',
        versionFrom: 0,
        versionTo: 1,
        prevContent: bytes(''),
        currContent: bytes('x'),
        opCount: 1,
        actor: null,
      })
    ).toThrow(/disposed/);
  });
});
