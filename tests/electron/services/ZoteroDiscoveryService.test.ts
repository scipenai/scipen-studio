/**
 * @file ZoteroDiscoveryService.test.ts
 * @description Unit tests for the Zotero discovery probe — three-way
 *   parallel check (Local API ping + filesystem scan + BBT ping) merged
 *   into a single ZoteroDetectionResultDTO.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((kind: string) => {
      if (kind === 'home') return '/home/test-user';
      return '/tmp';
    }),
  },
}));

vi.mock('fs', () => {
  const access = vi.fn(async () => undefined);
  return {
    promises: { access },
    default: { promises: { access } },
  };
});

import { promises as fs } from 'fs';
import { ZoteroDiscoveryService } from '../../../src/main/services/zotero/ZoteroDiscoveryService';
import type { ZoteroLocalApiClient } from '../../../src/main/services/zotero/ZoteroLocalApiClient';
import type { BetterBibTexClient } from '../../../src/main/services/zotero/BetterBibTexClient';

function makeApi(pingResult: { ok: boolean; version?: number; error?: string }): ZoteroLocalApiClient {
  return {
    ping: vi.fn(async () => pingResult),
    getItems: vi.fn(),
    getItemAnnotations: vi.fn(),
    getBaseUrl: () => 'http://127.0.0.1:23119',
  } as unknown as ZoteroLocalApiClient;
}

function makeBBT(pingResult: { ok: boolean; version?: string; error?: string }): BetterBibTexClient {
  return {
    ping: vi.fn(async () => pingResult),
    searchItems: vi.fn(),
    getAllCitations: vi.fn(),
    getCslByKey: vi.fn(),
    getEndpoint: () => 'http://127.0.0.1:23119/better-bibtex/json-rpc',
  } as unknown as BetterBibTexClient;
}

describe('ZoteroDiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns found=true with version + path + bbt=true when everything works', async () => {
    const api = makeApi({ ok: true, version: 7 });
    const bbt = makeBBT({ ok: true, version: '6.7.140' });
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const service = new ZoteroDiscoveryService(api, bbt);
    const result = await service.detect();

    expect(result.found).toBe(true);
    expect(result.version).toBe('7');
    expect(result.betterBibTexInstalled).toBe(true);
    expect(result.path).toMatch(/Zotero/);
  });

  it('returns found=true when only the FS scan succeeds (Local API off)', async () => {
    const api = makeApi({ ok: false, error: 'connection refused' });
    const bbt = makeBBT({ ok: false });
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const service = new ZoteroDiscoveryService(api, bbt);
    const result = await service.detect();

    expect(result.found).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.betterBibTexInstalled).toBe(false);
  });

  it('returns found=true when only the Local API ping succeeds (FS scan misses)', async () => {
    const api = makeApi({ ok: true, version: 8 });
    const bbt = makeBBT({ ok: false });
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const service = new ZoteroDiscoveryService(api, bbt);
    const result = await service.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBeUndefined();
    expect(result.version).toBe('8');
    expect(result.betterBibTexInstalled).toBe(false);
  });

  it('returns found=false but still surfaces bbt status when nothing is detected', async () => {
    const api = makeApi({ ok: false });
    const bbt = makeBBT({ ok: true, version: '6.7.140' });
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const service = new ZoteroDiscoveryService(api, bbt);
    const result = await service.detect();

    // BBT cannot run without Zotero, so this is a contradictory state we
    // surface verbatim — useful for diagnostic output, the wizard will
    // still gate on `found`.
    expect(result.found).toBe(false);
    expect(result.betterBibTexInstalled).toBe(true);
    expect(result.path).toBeUndefined();
  });

  it('runs all three probes in parallel', async () => {
    const order: string[] = [];
    const apiPing = vi.fn(async () => {
      order.push('api-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('api-end');
      return { ok: true };
    });
    const bbtPing = vi.fn(async () => {
      order.push('bbt-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('bbt-end');
      return { ok: false };
    });
    const api = { ping: apiPing } as unknown as ZoteroLocalApiClient;
    const bbt = { ping: bbtPing } as unknown as BetterBibTexClient;
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const service = new ZoteroDiscoveryService(api, bbt);
    await service.detect();

    // Both starts must come before either end => proves parallelism
    expect(order.indexOf('api-start')).toBeLessThan(order.indexOf('bbt-end'));
    expect(order.indexOf('bbt-start')).toBeLessThan(order.indexOf('api-end'));
  });
});
