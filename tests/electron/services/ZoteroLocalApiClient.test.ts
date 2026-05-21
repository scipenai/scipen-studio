/**
 * @file ZoteroLocalApiClient.test.ts
 * @description Unit tests for the Zotero Local API wrapper. Covers
 *   ping (success/failure/version parsing), getItems projection,
 *   and getItemAnnotations filtering.
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

import { ZoteroLocalApiClient } from '../../../src/main/services/zotero/ZoteroLocalApiClient';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('ZoteroLocalApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('ping', () => {
    it('returns ok=true with parsed major version from headers', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('[]', {
              status: 200,
              headers: { 'X-Zotero-Version': '7.0.15' },
            })
        )
      );
      const client = new ZoteroLocalApiClient();
      const result = await client.ping();
      expect(result.ok).toBe(true);
      expect(result.version).toBe(7);
    });

    it('returns ok=true with undefined version when headers lack one', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('[]', { status: 200 }))
      );
      const client = new ZoteroLocalApiClient();
      const result = await client.ping();
      expect(result.ok).toBe(true);
      expect(result.version).toBeUndefined();
    });

    it('returns ok=false with friendly hint when connection refused', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('fetch failed: ECONNREFUSED');
        })
      );
      const client = new ZoteroLocalApiClient();
      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not running or its Local API is not enabled/);
    });

    it('returns ok=false on non-200 responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('forbidden', { status: 403 }))
      );
      const client = new ZoteroLocalApiClient();
      const result = await client.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HTTP 403/);
    });
  });

  describe('getItems', () => {
    it('projects Zotero items to ZoteroItemDTO with creators and year', async () => {
      const payload = [
        {
          key: 'ABC123',
          bib: '<div>Smith 2024.</div>',
          citation: '(Smith, 2024)',
          data: {
            key: 'ABC123',
            itemType: 'journalArticle',
            title: 'Deep Learning',
            abstractNote: 'A study.',
            date: '2024-03-15',
            creators: [
              { firstName: 'Alice', lastName: 'Smith' },
              { firstName: 'Bob', lastName: 'Jones' },
            ],
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

      const client = new ZoteroLocalApiClient();
      const items = await client.getItems({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        itemKey: 'ABC123',
        itemType: 'journalArticle',
        title: 'Deep Learning',
        creatorsLabel: 'Smith, Jones',
        year: 2024,
        abstractNote: 'A study.',
        bib: '<div>Smith 2024.</div>',
        citation: '(Smith, 2024)',
      });
    });

    it('uses "et al." when 4+ creators', async () => {
      const payload = [
        {
          data: {
            key: 'X',
            itemType: 'journalArticle',
            title: 't',
            creators: [
              { lastName: 'A' },
              { lastName: 'B' },
              { lastName: 'C' },
              { lastName: 'D' },
            ],
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.creatorsLabel).toBe('A, B et al.');
    });

    it('skips entries without data.key', async () => {
      const payload = [{ data: { itemType: 'note', title: 'no key' } }, { foo: 'bar' }];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items).toEqual([]);
    });

    it('clamps limit to MAX_PAGE_SIZE (100) and sends start offset', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      const client = new ZoteroLocalApiClient();
      await client.getItems({ limit: 500, start: 200 });
      expect(captured[0]).toMatch(/limit=100/);
      expect(captured[0]).toMatch(/start=200/);
    });

    it('throws on non-200 HTTP response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('boom', { status: 500 }))
      );
      const client = new ZoteroLocalApiClient();
      await expect(client.getItems()).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('getItemAnnotations', () => {
    it('returns [] for empty itemKey without fetching', async () => {
      const fetchSpy = vi.fn(async () => jsonResponse([]));
      vi.stubGlobal('fetch', fetchSpy);
      const client = new ZoteroLocalApiClient();
      const result = await client.getItemAnnotations('');
      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('projects annotation children to ZoteroAnnotationDTO', async () => {
      const payload = [
        {
          key: 'ANN1',
          data: {
            key: 'ANN1',
            itemType: 'annotation',
            parentItem: 'PARENT',
            annotationType: 'highlight',
            annotationText: 'important sentence',
            annotationColor: '#ffd400',
            annotationPageLabel: '5',
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const result = await client.getItemAnnotations('PARENT');
      expect(result).toEqual([
        {
          itemKey: 'ANN1',
          parentItemKey: 'PARENT',
          annotationType: 'highlight',
          annotationText: 'important sentence',
          annotationComment: undefined,
          annotationColor: '#ffd400',
          annotationPageLabel: '5',
        },
      ]);
    });

    it('filters out non-annotation children', async () => {
      const payload = [
        { key: 'X', data: { key: 'X', itemType: 'note' } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const result = await client.getItemAnnotations('PARENT');
      expect(result).toEqual([]);
    });

    it('falls back to provided parent when raw lacks parentItem', async () => {
      const payload = [
        {
          key: 'ANN2',
          data: {
            key: 'ANN2',
            itemType: 'annotation',
            annotationType: 'note',
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const result = await client.getItemAnnotations('FALLBACK');
      expect(result[0]?.parentItemKey).toBe('FALLBACK');
    });

    it('URL-encodes itemKey in the path', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      const client = new ZoteroLocalApiClient();
      await client.getItemAnnotations('a/b key');
      expect(captured[0]).toMatch(/a%2Fb%20key/);
    });
  });
});
