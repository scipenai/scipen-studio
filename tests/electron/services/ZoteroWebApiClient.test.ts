/**
 * @file ZoteroWebApiClient.test.ts
 * @description Unit tests for ZoteroWebApiClient. Covers:
 *   - ping classification: success (200) + username / 401 invalid / 403 permission / 404 user / 429 / network
 *   - getItems URL contract (baseUrl + /users/{userID}/items/top + include= + auth headers)
 *   - Pagination (getAllItems terminates on an empty page)
 *   - fetchJson 429 Retry-After retry (≤3 attempts) + one 5xx backoff
 *   - HTTP error mapping (unclassified 4xx throws)
 *   - Constructor argument validation (empty userId / apiKey throws)
 * The mock only stubs global fetch; no dependency on electron or real network.
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

import { ZoteroWebApiClient } from '../../../src/main/services/zotero/ZoteroWebApiClient';

const USER_ID = '123456';
const API_KEY = 'test-key-abcdef';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeClient(overrides: Partial<{ requestTimeoutMs: number; pingTimeoutMs: number }> = {}) {
  return new ZoteroWebApiClient({
    userId: USER_ID,
    apiKey: API_KEY,
    // Tighten timeouts for the network-timeout test paths without blocking CI.
    requestTimeoutMs: overrides.requestTimeoutMs ?? 500,
    pingTimeoutMs: overrides.pingTimeoutMs ?? 300,
  });
}

describe('ZoteroWebApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('throws on empty userId', () => {
      expect(() => new ZoteroWebApiClient({ userId: '', apiKey: API_KEY })).toThrow(/userId/);
    });
    it('throws on empty apiKey', () => {
      expect(() => new ZoteroWebApiClient({ userId: USER_ID, apiKey: '' })).toThrow(/apiKey/);
    });
    it('strips trailing slash from baseUrl', () => {
      const c = new ZoteroWebApiClient({
        userId: USER_ID,
        apiKey: API_KEY,
        baseUrl: 'https://api.zotero.org///',
      });
      expect(c.getBaseUrl()).toBe('https://api.zotero.org');
    });
  });

  describe('ping', () => {
    it('returns ok=true with username on successful auth', async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(url);
          if (/\/users\/123456\/items\?limit=1/.test(url)) {
            return jsonResponse([]);
          }
          if (/\/users\/123456\?format=json/.test(url)) {
            return jsonResponse({ username: 'alice' });
          }
          throw new Error(`Unexpected URL: ${url}`);
        })
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(true);
      expect(result.username).toBe('alice');
    });

    it('returns ok=true without username when profile endpoint returns nothing usable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (/items\?limit=1/.test(url)) return jsonResponse([]);
          return jsonResponse({});
        })
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(true);
      expect(result.username).toBeUndefined();
    });

    it('returns ok=false "invalid API key" on 401', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unauthorized', { status: 401 }))
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid|expired/i);
    });

    it('returns ok=false "permissions" on 403', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('forbidden', { status: 403 }))
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/permission/i);
    });

    it('returns ok=false "user not found" on 404', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('not found', { status: 404 }))
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/user id not found/i);
    });

    it('returns ok=false with rate-limit hint on 429', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429 }))
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/rate limited/i);
    });

    it('classifies network failure as unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('fetch failed: ENOTFOUND api.zotero.org');
        })
      );
      const result = await makeClient().ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cannot reach api\.zotero\.org/i);
    });
  });

  describe('getItems — URL contract', () => {
    it('sends userId in path, uses HTTPS baseUrl by default', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      await makeClient().getItems();
      expect(captured[0]).toMatch(/^https:\/\/api\.zotero\.org\/users\/123456\/items\/top\?/);
      expect(captured[0]).toMatch(/include=data,bib,citation/);
      expect(captured[0]).toMatch(/style=apa/);
    });

    it('sends Zotero-API-Key + Zotero-API-Version: 3 headers', async () => {
      let capturedHeaders: Headers | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          const h = new Headers(init?.headers as HeadersInit | undefined);
          capturedHeaders = h;
          return jsonResponse([]);
        })
      );
      await makeClient().getItems();
      expect(capturedHeaders).not.toBeNull();
      const h = capturedHeaders as unknown as Headers;
      expect(h.get('Zotero-API-Key')).toBe(API_KEY);
      expect(h.get('Zotero-API-Version')).toBe('3');
    });

    it('clamps limit to 100 and passes start offset', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      await makeClient().getItems({ limit: 500, start: 25 });
      expect(captured[0]).toMatch(/limit=100/);
      expect(captured[0]).toMatch(/start=25/);
    });

    it('throws on 4xx non-classified errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('bad request', { status: 400 }))
      );
      await expect(makeClient().getItems()).rejects.toThrow(/HTTP 400/);
    });
  });

  describe('getItems — projection', () => {
    it('projects real journalArticle with creators/year', async () => {
      const payload = [
        {
          key: 'ABC',
          data: {
            key: 'ABC',
            itemType: 'journalArticle',
            title: 'Deep NLP',
            date: '2024-06',
            creators: [{ lastName: 'Smith' }, { lastName: 'Jones' }],
          },
        },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(payload))
      );
      const items = await makeClient().getItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        itemKey: 'ABC',
        itemType: 'journalArticle',
        title: 'Deep NLP',
        creatorsLabel: 'Smith, Jones',
        year: 2024,
      });
    });

    it('reads citationKey from BBT-synced data field', async () => {
      const payload = [
        {
          data: { key: 'K2', itemType: 'journalArticle', title: 't', citationKey: 'smith2024deep' },
        },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(payload))
      );
      const items = await makeClient().getItems();
      expect(items[0]?.citationKey).toBe('smith2024deep');
    });

    it('drops attachment / annotation / note leftovers', async () => {
      const payload = [
        { data: { key: 'A', itemType: 'attachment', title: 'foo.pdf' } },
        { data: { key: 'B', itemType: 'note' } },
        { data: { key: 'C', itemType: 'journalArticle', title: 'Paper' } },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(payload))
      );
      const items = await makeClient().getItems();
      expect(items.map((i) => i.itemKey)).toEqual(['C']);
    });
  });

  describe('getAllItems — pagination', () => {
    it('paginates until an empty batch', async () => {
      const pages: unknown[][] = [
        Array.from({ length: 100 }, (_, i) => ({
          data: { key: `A${i}`, itemType: 'journalArticle', title: `t${i}` },
        })),
        Array.from({ length: 20 }, (_, i) => ({
          data: { key: `B${i}`, itemType: 'journalArticle', title: `s${i}` },
        })),
      ];
      let page = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const body = page < pages.length ? pages[page] : [];
          page++;
          return jsonResponse(body);
        })
      );
      const items = await makeClient().getAllItems();
      // 100 (full page) + 20 (short page terminator) = 120
      expect(items).toHaveLength(120);
    });

    it('respects maxPages guard', async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          return jsonResponse(
            Array.from({ length: 100 }, (_, i) => ({
              data: { key: `X${calls}_${i}`, itemType: 'journalArticle', title: 't' },
            }))
          );
        })
      );
      const items = await makeClient().getAllItems(3);
      expect(calls).toBe(3);
      expect(items).toHaveLength(300);
    });
  });

  describe('fetchJson — rate limit retry', () => {
    it('retries on 429 respecting Retry-After header, then succeeds', async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          if (calls === 1) {
            return new Response('rate', {
              status: 429,
              headers: { 'Retry-After': '0.1' }, // 100ms
            });
          }
          return jsonResponse([]);
        })
      );
      const items = await makeClient().getItems();
      expect(calls).toBe(2);
      expect(items).toEqual([]);
    });

    it('gives up after 3 retries', async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          return new Response('rate', {
            status: 429,
            headers: { 'Retry-After': '0.05' },
          });
        })
      );
      await expect(makeClient().getItems()).rejects.toThrow(/rate-limited|retry budget/i);
      // Initial attempt + up to 3 retries. Implementation checks budget BEFORE
      // sleeping, so the 4th call is still an attempt that throws — bounded call count = 4.
      expect(calls).toBeLessThanOrEqual(4);
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });

  describe('fetchJson — 5xx backoff', () => {
    it('retries once on 500 then succeeds', async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          if (calls === 1) return new Response('boom', { status: 502 });
          return jsonResponse([]);
        })
      );
      const items = await makeClient().getItems();
      expect(calls).toBe(2);
      expect(items).toEqual([]);
    });

    it('throws on second 5xx without further retries', async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          return new Response('boom', { status: 502 });
        })
      );
      await expect(makeClient().getItems()).rejects.toThrow(/HTTP 502/);
      expect(calls).toBe(2);
    });
  });

  describe('getItemAnnotations', () => {
    it('returns [] for empty itemKey without fetching', async () => {
      const spy = vi.fn(async () => jsonResponse([]));
      vi.stubGlobal('fetch', spy);
      const result = await makeClient().getItemAnnotations('');
      expect(result).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('URL-encodes user + item key in path', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      await makeClient().getItemAnnotations('a/b key');
      expect(captured[0]).toContain('/users/123456/items/a%2Fb%20key/children');
      expect(captured[0]).toMatch(/itemType=annotation/);
      expect(captured[0]).toMatch(/include=data/);
    });
  });
});
