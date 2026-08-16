/**
 * @file ZoteroDataSource.test.ts
 * @description Covers both facade impls — LocalDataSource (thin delegation)
 *              + WebDataSource (delegation + explicit sentinels for
 *              capabilities that have no meaningful web-mode implementation).
 *
 *              Focus: sentinel correctness (getFullText.tier / getCsl null)
 *              and delegation shape (arg pass-through + empty-input guards).
 *              Client-level HTTP behavior is tested by their own suites;
 *              here we only verify the facade doesn't accidentally lose data.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroFullTextResultDTO,
  ZoteroItemDTO,
} from '../../../shared/types/zotero';
import { ZoteroLocalDataSource } from '../../../src/main/services/zotero/ZoteroLocalDataSource';
import { ZoteroWebDataSource } from '../../../src/main/services/zotero/ZoteroWebDataSource';

const anItem = (key: string): ZoteroItemDTO => ({
  itemKey: key,
  itemType: 'journalArticle',
  title: `Paper ${key}`,
});

const anAnnotation = (key: string): ZoteroAnnotationDTO => ({
  itemKey: `${key}-ann`,
  parentItemKey: key,
  annotationType: 'highlight',
  annotationText: 'note',
});

const anAttachment = (key: string): ZoteroAttachmentDTO => ({
  itemKey: `${key}-att`,
  contentType: 'application/pdf',
  filename: `${key}.pdf`,
  linkMode: 'imported_file',
});

describe('ZoteroLocalDataSource', () => {
  function makeSource(
    overrides: {
      localApi?: Partial<{
        ping: ReturnType<typeof vi.fn>;
        getAllItems: ReturnType<typeof vi.fn>;
        getItemAnnotations: ReturnType<typeof vi.fn>;
        getItemAttachments: ReturnType<typeof vi.fn>;
      }>;
      bbt?: Partial<{ getCslByKey: ReturnType<typeof vi.fn> }>;
      fullTextService?: Partial<{ getFullText: ReturnType<typeof vi.fn> }>;
    } = {}
  ) {
    return new ZoteroLocalDataSource({
      localApi: {
        ping: overrides.localApi?.ping ?? vi.fn(async () => ({ ok: true, version: 7 })),
        getAllItems: overrides.localApi?.getAllItems ?? vi.fn(async () => []),
        getItemAnnotations: overrides.localApi?.getItemAnnotations ?? vi.fn(async () => []),
        getItemAttachments: overrides.localApi?.getItemAttachments ?? vi.fn(async () => []),
      } as never,
      bbt: {
        getCslByKey: overrides.bbt?.getCslByKey ?? vi.fn(async () => null),
      } as never,
      fullTextService: {
        getFullText:
          overrides.fullTextService?.getFullText ??
          vi.fn(async () => ({ text: '', truncated: false, tier: 'none' })),
      } as never,
    });
  }

  it('kind is "local"', () => {
    expect(makeSource().kind).toBe('local');
  });

  describe('ping', () => {
    it('flattens localApi ok → { ok: true }', async () => {
      const src = makeSource({ localApi: { ping: vi.fn(async () => ({ ok: true, version: 7 })) } });
      expect(await src.ping()).toEqual({ ok: true });
    });

    it('flattens localApi failure → { ok: false, error }', async () => {
      const src = makeSource({
        localApi: { ping: vi.fn(async () => ({ ok: false, error: 'ECONNREFUSED' })) },
      });
      expect(await src.ping()).toEqual({ ok: false, error: 'ECONNREFUSED' });
    });

    it('supplies default error when localApi omits one', async () => {
      const src = makeSource({ localApi: { ping: vi.fn(async () => ({ ok: false })) } });
      expect((await src.ping()).error).toMatch(/unreachable/i);
    });
  });

  describe('delegation', () => {
    it('getAllItems passes through', async () => {
      const items = [anItem('A'), anItem('B')];
      const src = makeSource({ localApi: { getAllItems: vi.fn(async () => items) } });
      expect(await src.getAllItems()).toBe(items);
    });

    it('getItemAnnotations short-circuits on empty itemKey (no fetch)', async () => {
      const spy = vi.fn(async () => [anAnnotation('X')]);
      const src = makeSource({ localApi: { getItemAnnotations: spy } });
      expect(await src.getItemAnnotations('')).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('getItemAnnotations forwards non-empty itemKey', async () => {
      const spy = vi.fn(async () => [anAnnotation('A')]);
      const src = makeSource({ localApi: { getItemAnnotations: spy } });
      const result = await src.getItemAnnotations('A');
      expect(spy).toHaveBeenCalledWith('A');
      expect(result).toHaveLength(1);
    });

    it('getItemAttachments short-circuits on empty itemKey', async () => {
      const spy = vi.fn(async () => [anAttachment('X')]);
      const src = makeSource({ localApi: { getItemAttachments: spy } });
      expect(await src.getItemAttachments('')).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('getFullText delegates to fullTextService', async () => {
      const payload: ZoteroFullTextResultDTO = {
        text: 'hello',
        truncated: false,
        tier: 'local',
        quality: 'good',
      };
      const spy = vi.fn(async () => payload);
      const src = makeSource({ fullTextService: { getFullText: spy } });
      expect(await src.getFullText('A')).toBe(payload);
      expect(spy).toHaveBeenCalledWith('A');
    });

    it('getFullText catches fullTextService throws (facade contract: never throws)', async () => {
      const spy = vi.fn(async () => {
        throw new Error('fs error');
      });
      const src = makeSource({ fullTextService: { getFullText: spy } });
      // Must NOT reject — degrades to tier:'none' per interface contract.
      const result = await src.getFullText('A');
      expect(result).toEqual({ text: '', truncated: false, tier: 'none' });
    });

    it('getCslByCitationKey short-circuits on empty key', async () => {
      const spy = vi.fn(async () => ({ title: 'x' }));
      const src = makeSource({ bbt: { getCslByKey: spy } });
      expect(await src.getCslByCitationKey('')).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('getCslByCitationKey forwards non-empty key', async () => {
      const csl = { id: 'smith2024', type: 'article-journal' };
      const spy = vi.fn(async () => csl);
      const src = makeSource({ bbt: { getCslByKey: spy } });
      expect(await src.getCslByCitationKey('smith2024')).toBe(csl);
    });
  });
});

describe('ZoteroWebDataSource', () => {
  function makeSource(
    overrides: Partial<{
      ping: ReturnType<typeof vi.fn>;
      getAllItems: ReturnType<typeof vi.fn>;
      getItemAnnotations: ReturnType<typeof vi.fn>;
      getItemAttachments: ReturnType<typeof vi.fn>;
    }> = {}
  ) {
    return new ZoteroWebDataSource({
      client: {
        ping: overrides.ping ?? vi.fn(async () => ({ ok: true, username: 'alice' })),
        getAllItems: overrides.getAllItems ?? vi.fn(async () => []),
        getItemAnnotations: overrides.getItemAnnotations ?? vi.fn(async () => []),
        getItemAttachments: overrides.getItemAttachments ?? vi.fn(async () => []),
      } as never,
    });
  }

  it('kind is "web"', () => {
    expect(makeSource().kind).toBe('web');
  });

  describe('ping', () => {
    it('ok=true carries username as detail', async () => {
      const src = makeSource({ ping: vi.fn(async () => ({ ok: true, username: 'alice' })) });
      const result = await src.ping();
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/alice/);
    });

    it('ok=true without username omits detail', async () => {
      const src = makeSource({ ping: vi.fn(async () => ({ ok: true })) });
      expect(await src.ping()).toEqual({ ok: true, detail: undefined });
    });

    it('flattens failure → { ok: false, error }', async () => {
      const src = makeSource({
        ping: vi.fn(async () => ({ ok: false, error: 'invalid api key' })),
      });
      expect(await src.ping()).toEqual({ ok: false, error: 'invalid api key' });
    });

    it('catches client.ping throws (facade contract: never throws)', async () => {
      const src = makeSource({
        ping: vi.fn(async () => {
          throw new Error('unexpected throw');
        }),
      });
      const result = await src.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('unexpected throw');
    });
  });

  describe('sentinels — the whole point of the facade', () => {
    it('getFullText returns web_pending sentinel regardless of itemKey', async () => {
      const src = makeSource();
      const result = await src.getFullText('any-item-key');
      expect(result).toEqual({ text: '', truncated: false, tier: 'web_pending' });
    });

    it('getCslByCitationKey returns null (no BBT in web mode)', async () => {
      const src = makeSource();
      expect(await src.getCslByCitationKey('smith2024deep')).toBeNull();
    });
  });

  describe('capabilities that DO work over Web API', () => {
    it('getAllItems delegates to client', async () => {
      const items = [anItem('W1'), anItem('W2')];
      const src = makeSource({ getAllItems: vi.fn(async () => items) });
      expect(await src.getAllItems()).toBe(items);
    });

    it('getItemAnnotations short-circuits on empty', async () => {
      const spy = vi.fn(async () => [anAnnotation('X')]);
      const src = makeSource({ getItemAnnotations: spy });
      expect(await src.getItemAnnotations('')).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('getItemAnnotations forwards non-empty itemKey', async () => {
      const spy = vi.fn(async () => [anAnnotation('W')]);
      const src = makeSource({ getItemAnnotations: spy });
      await src.getItemAnnotations('W');
      expect(spy).toHaveBeenCalledWith('W');
    });

    it('getItemAttachments delegates', async () => {
      const atts = [anAttachment('W')];
      const spy = vi.fn(async () => atts);
      const src = makeSource({ getItemAttachments: spy });
      expect(await src.getItemAttachments('W')).toBe(atts);
    });
  });
});
