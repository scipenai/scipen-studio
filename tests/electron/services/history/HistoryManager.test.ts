/**
 * @file HistoryManager lifecycle tests.
 *
 * Per-project lazy creation, instance sharing, scoped close, and dispose-all.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HistoryManager,
  createHistoryManager,
} from '../../../../src/main/services/history/HistoryManager';

let baseDir: string;
let mgr: HistoryManager;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scipen-history-mgr-'));
  mgr = createHistoryManager({ baseDir, inlineMaxBytes: 16 });
});

afterEach(async () => {
  await mgr.dispose();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('HistoryManager', () => {
  it('lazy creates a HistoryService for an unseen projectId', () => {
    expect(mgr.has('p1')).toBe(false);
    const svc = mgr.getOrCreate('p1');
    expect(svc).toBeDefined();
    expect(mgr.has('p1')).toBe(true);
  });

  it('returns the same instance for the same projectId (single-writer invariant)', () => {
    const a = mgr.getOrCreate('p1');
    const b = mgr.getOrCreate('p1');
    expect(a).toBe(b);
  });

  it('returns distinct instances for distinct projectIds', () => {
    const a = mgr.getOrCreate('p1');
    const b = mgr.getOrCreate('p2');
    expect(a).not.toBe(b);
  });

  it('lays out per-project files under {baseDir}/projects/{projectId}/history', async () => {
    mgr.getOrCreate('p-foo');
    const expected = path.join(baseDir, 'projects', 'p-foo', 'history');
    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);
    const dbStat = await fs.stat(path.join(expected, 'meta.db'));
    expect(dbStat.isFile()).toBe(true);
  });

  it('close releases the slot so the next getOrCreate builds a fresh instance', async () => {
    const a = mgr.getOrCreate('p1');
    await mgr.close('p1');
    expect(mgr.has('p1')).toBe(false);
    const b = mgr.getOrCreate('p1');
    // Reference comparison: don't pass disposed `a` through expect()'s
    // pretty-printer (node:sqlite getters throw "statement has been
    // finalized" when walked post-close).
    expect(b === a).toBe(false);
  });

  it('close on an unknown projectId is a no-op', async () => {
    await expect(mgr.close('never-opened')).resolves.toBeUndefined();
  });

  it('dispose releases every open instance', async () => {
    mgr.getOrCreate('p1');
    mgr.getOrCreate('p2');
    await mgr.dispose();
    expect(mgr.has('p1')).toBe(false);
    expect(mgr.has('p2')).toBe(false);
  });

  it('post-dispose calls fail loudly rather than silently constructing again', async () => {
    await mgr.dispose();
    expect(() => mgr.getOrCreate('p1')).toThrow(/disposed/);
  });

  it('dispose is idempotent', async () => {
    await mgr.dispose();
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it('rejects projectId values that would escape the base dir', () => {
    for (const bad of ['..', '../evil', 'foo/bar', 'foo\\bar', '.', '', 'x'.repeat(200)]) {
      expect(() => mgr.getOrCreate(bad)).toThrow(/Invalid projectId/);
    }
  });

  it('sweepAll fans out across every open project and reports counts', async () => {
    const svcA = mgr.getOrCreate('proj_a');
    const svcB = mgr.getOrCreate('proj_b');
    // Make a soon-to-be orphan in proj_a: large blob -> on disk + DB row.
    const big = new TextEncoder().encode('x'.repeat(64));
    await svcA.putBlob(big);
    // proj_b stays empty.
    void svcB;

    // First sweep with default age (24h) — too young, nothing reaped.
    const fresh = await mgr.sweepAll();
    expect(fresh.rows).toBe(0);

    // Build a separate manager with zero min-age and sweep again.
    await mgr.dispose();
    mgr = createHistoryManager({ baseDir, inlineMaxBytes: 16, sweepMinAgeMs: 0 });
    const svcA2 = mgr.getOrCreate('proj_a');
    await svcA2.putBlob(big);
    const aged = await mgr.sweepAll();
    expect(aged.rows).toBeGreaterThan(0);
  });
});
