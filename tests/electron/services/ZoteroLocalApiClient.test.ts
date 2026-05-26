/**
 * @file ZoteroLocalApiClient.test.ts
 * @description ZoteroLocalApiClient 单元测试。覆盖 ping(成功/失败/版本解析)、
 *   getItems 投影(itemType 过滤 / meta fallback / bib 空壳归一)、URL endpoint
 *   契约,以及 getItemAnnotations。fixture 取自真实 Zotero Local API 联调数据。
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

  describe('getItems — URL contract', () => {
    it('hits /items/top with include=data,bib,citation (regression for D-1 include bug)', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      const client = new ZoteroLocalApiClient();
      await client.getItems();
      expect(captured[0]).toMatch(/\/api\/users\/0\/items\/top\?/);
      expect(captured[0]).toMatch(/include=data%2Cbib%2Ccitation|include=data,bib,citation/);
      expect(captured[0]).toMatch(/style=apa/);
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

  describe('getItems — projection', () => {
    it('projects a real journalArticle with creators/year/bib/citation', async () => {
      const payload = [
        {
          key: 'ABC123',
          bib: '<div class="csl-bib-body"><div class="csl-entry">Smith 2024.</div></div>',
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
        citation: '(Smith, 2024)',
      });
      expect(items[0]?.bib).toContain('csl-entry');
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

    it('reads citationKey from data (BBT-injected schema field, no RPC needed)', async () => {
      const payload = [
        {
          key: 'K2I2YK7G',
          data: {
            key: 'K2I2YK7G',
            itemType: 'journalArticle',
            title: 't',
            citationKey: 'caraiAddendumTheoryImplicit2025',
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.citationKey).toBe('caraiAddendumTheoryImplicit2025');
    });

    it('citationKey is undefined when data lacks the BBT-injected field', async () => {
      const payload = [
        { data: { key: 'X', itemType: 'journalArticle', title: 't' } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.citationKey).toBeUndefined();
    });

    it('falls back to meta.creatorSummary when data.creators is absent', async () => {
      const payload = [
        {
          key: 'K2I2YK7G',
          data: {
            key: 'K2I2YK7G',
            itemType: 'journalArticle',
            title: 'Implicit Operations Addendum',
          },
          meta: { creatorSummary: 'Carai 等', parsedDate: '2025-12-16' },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.creatorsLabel).toBe('Carai 等');
      expect(items[0]?.year).toBe(2025);
    });

    it('falls back to meta.parsedDate when data.date is absent', async () => {
      const payload = [
        {
          data: {
            key: 'Y',
            itemType: 'webpage',
            title: 'DeepSeek',
          },
          meta: { parsedDate: '2026-05-21' },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.year).toBe(2026);
    });

    it('drops attachment / annotation / note even if returned by /items/top', async () => {
      const payload = [
        { data: { key: 'A', itemType: 'attachment', title: 'foo.pdf' } },
        { data: { key: 'B', itemType: 'annotation' } },
        { data: { key: 'C', itemType: 'note', title: 'memo' } },
        { data: { key: 'D', itemType: 'journalArticle', title: 'Paper' } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items.map((i) => i.itemKey)).toEqual(['D']);
    });

    it('normalises an empty csl-bib-body shell to undefined', async () => {
      const payload = [
        {
          key: 'E',
          bib: '<div class="csl-bib-body" style="line-height: 2;">\n</div>',
          citation: '',
          data: { key: 'E', itemType: 'report', title: 'Empty Report' },
        },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items[0]?.bib).toBeUndefined();
      expect(items[0]?.citation).toBeUndefined();
    });

    it('warns and skips entries missing data field (include= misconfig sentinel)', async () => {
      const payload = [
        { key: 'NO_DATA', bib: '<div>...</div>' }, // 缺 data
        { data: { key: 'OK', itemType: 'journalArticle', title: 't' } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items.map((i) => i.itemKey)).toEqual(['OK']);
    });

    it('skips entries without itemKey at all', async () => {
      const payload = [{ data: { itemType: 'journalArticle', title: 'no key' } }];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const client = new ZoteroLocalApiClient();
      const items = await client.getItems();
      expect(items).toEqual([]);
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

    it('includes data field in URL (regression for D-1 include bug)', async () => {
      const captured: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          captured.push(url);
          return jsonResponse([]);
        })
      );
      const client = new ZoteroLocalApiClient();
      await client.getItemAnnotations('PARENT');
      expect(captured[0]).toMatch(/include=data/);
      expect(captured[0]).toMatch(/itemType=annotation/);
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
      const payload = [{ key: 'X', data: { key: 'X', itemType: 'note' } }];
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
