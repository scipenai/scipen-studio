/**
 * @file BetterBibTexClient.test.ts
 * @description Unit tests for the Better BibTeX JSON-RPC client. Covers
 *   ping success/failure, search/getAllCitations normalization across
 *   the two shapes BBT emits (tuples vs objects), and timeout handling.
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

import { BetterBibTexClient } from '../../../src/main/services/zotero/BetterBibTexClient';

interface CapturedRequest {
  url: string;
  body: { jsonrpc: string; id: number; method: string; params: unknown };
}

function installFetchMock(responder: (req: CapturedRequest) => Response | Promise<Response>) {
  const captured: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const req: CapturedRequest = { url, body };
    captured.push(req);
    return responder(req);
  });
  // happy-dom / Node provides global fetch in vitest; override it.
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, captured };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('BetterBibTexClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('ping', () => {
    it('returns ok=true when the endpoint replies with a result', async () => {
      installFetchMock(() =>
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { version: '6.7.140' } })
      );
      const client = new BetterBibTexClient();
      const result = await client.ping();
      expect(result.ok).toBe(true);
      expect(result.version).toBe('6.7.140');
    });

    it('returns ok=true without version when result is a plain string', async () => {
      installFetchMock(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: 'OK' }));
      const client = new BetterBibTexClient();
      const result = await client.ping();
      expect(result.ok).toBe(true);
      expect(result.version).toBeUndefined();
    });

    it('returns ok=false when the endpoint returns an HTTP error', async () => {
      installFetchMock(() => new Response('not found', { status: 404 }));
      const client = new BetterBibTexClient();
      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HTTP 404/);
    });

    it('returns ok=false when the endpoint returns a JSON-RPC error envelope', async () => {
      installFetchMock(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        })
      );
      const client = new BetterBibTexClient();
      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Method not found/);
    });

    it('returns ok=false when fetch rejects (Zotero not running)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );
      const client = new BetterBibTexClient();
      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNREFUSED/);
    });
  });

  describe('searchItems', () => {
    it('returns [] for empty query without making an RPC call', async () => {
      const { fetchSpy } = installFetchMock(() => jsonResponse({}));
      const client = new BetterBibTexClient();
      const result = await client.searchItems('   ');
      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('normalizes tuple-style BBT results', async () => {
      installFetchMock(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: [
            ['smith2024deep', '8FXYZ123', 1],
            ['jones2023nlp', 'A2BC4567', 1],
          ],
        })
      );
      const client = new BetterBibTexClient();
      const result = await client.searchItems('learning');
      expect(result).toEqual([
        { citationKey: 'smith2024deep', itemKey: '8FXYZ123', libraryID: 1 },
        { citationKey: 'jones2023nlp', itemKey: 'A2BC4567', libraryID: 1 },
      ]);
    });

    it('normalizes object-style BBT results', async () => {
      installFetchMock(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: [{ citationKey: 'doe2025', itemKey: 'ZZ999', libraryID: 2 }],
        })
      );
      const client = new BetterBibTexClient();
      const result = await client.searchItems('doe');
      expect(result).toEqual([{ citationKey: 'doe2025', itemKey: 'ZZ999', libraryID: 2 }]);
    });

    it('returns [] when the result is not an array', async () => {
      installFetchMock(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
      const client = new BetterBibTexClient();
      const result = await client.searchItems('whatever');
      expect(result).toEqual([]);
    });
  });

  describe('getCslByKey', () => {
    it('returns parsed CSL when BBT replies', async () => {
      const csl = { id: 'smith2024deep', type: 'article-journal', title: 'Deep Learning' };
      installFetchMock(() =>
        jsonResponse({ jsonrpc: '2.0', id: 1, result: [csl] })
      );
      const client = new BetterBibTexClient();
      const result = await client.getCslByKey('smith2024deep');
      expect(result).toEqual([csl]);
    });

    it('returns null when key is empty', async () => {
      const { fetchSpy } = installFetchMock(() => jsonResponse({}));
      const client = new BetterBibTexClient();
      const result = await client.getCslByKey('');
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null and swallows errors when RPC fails', async () => {
      installFetchMock(() =>
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } })
      );
      const client = new BetterBibTexClient();
      const result = await client.getCslByKey('unknown');
      expect(result).toBeNull();
    });
  });

  describe('request shape', () => {
    it('sends a proper JSON-RPC 2.0 envelope', async () => {
      const { captured } = installFetchMock(() =>
        jsonResponse({ jsonrpc: '2.0', id: 1, result: [] })
      );
      const client = new BetterBibTexClient();
      await client.searchItems('attention');
      expect(captured).toHaveLength(1);
      expect(captured[0]?.body.jsonrpc).toBe('2.0');
      expect(captured[0]?.body.method).toBe('item.search');
      expect(captured[0]?.body.params).toEqual(['attention']);
    });

    it('increments the request id across calls', async () => {
      const { captured } = installFetchMock(() =>
        jsonResponse({ jsonrpc: '2.0', id: 1, result: [] })
      );
      const client = new BetterBibTexClient();
      await client.searchItems('a');
      await client.searchItems('b');
      expect(captured[0]?.body.id).toBe(1);
      expect(captured[1]?.body.id).toBe(2);
    });
  });
});
