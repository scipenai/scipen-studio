/**
 * @file ZoteroIndex.test.ts
 * @description Unit tests for the canonical bib index. Covers hydrate /
 *   patch / etag semantics, snapshot building, citation-key rewiring
 *   and the delta-log overflow path.
 */

import { describe, expect, it } from 'vitest';
import { ZoteroIndex } from '../../../src/main/services/zotero/ZoteroIndex';
import type { ZoteroItemDTO } from '../../../shared/types/zotero';

function item(itemKey: string, ck?: string, title?: string): ZoteroItemDTO {
  return {
    itemKey,
    itemType: 'journalArticle',
    title: title ?? `Paper ${itemKey}`,
    creatorsLabel: 'Doe',
    year: 2024,
    citationKey: ck,
  };
}

describe('ZoteroIndex / hydrate', () => {
  it('hydrate replaces contents and emits a new etag', () => {
    const idx = new ZoteroIndex();
    const tag1 = idx.hydrate([item('AAA', 'first2024')]);
    const tag2 = idx.hydrate([item('BBB', 'second2024')]);
    expect(tag1).not.toBe(tag2);
    expect(idx.getByItemKey('AAA')).toBeUndefined();
    expect(idx.getByItemKey('BBB')).toBeDefined();
  });

  it('citation-key map is rebuilt on hydrate', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'foo')]);
    idx.hydrate([item('BBB', 'foo')]);  // ck moved to a different itemKey
    expect(idx.getByCitationKey('foo')?.itemKey).toBe('BBB');
  });

  it('hydrate clears the delta log', () => {
    const idx = new ZoteroIndex(8);
    idx.hydrate([item('AAA', 'a')]);
    const tagAfterFirst = idx.getEtag();
    idx.applyPatch([item('BBB', 'b')], []);
    idx.hydrate([item('CCC', 'c')]);
    // After re-hydrate, the cursor that worked before should be forced
    // to reset rather than receiving a stale patch.
    const snap = idx.buildSnapshotSince(tagAfterFirst);
    expect(snap.reset).toBe(true);
  });
});

describe('ZoteroIndex / applyPatch', () => {
  it('upserts add or replace items', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'foo', 'Original')]);
    idx.applyPatch([item('AAA', 'foo', 'Renamed'), item('BBB', 'bar')], []);

    expect(idx.getByItemKey('AAA')?.title).toBe('Renamed');
    expect(idx.getByItemKey('BBB')).toBeDefined();
  });

  it('rewiring a citation key drops the stale reverse mapping', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'oldKey')]);
    idx.applyPatch([item('AAA', 'newKey')], []);

    expect(idx.getByCitationKey('oldKey')).toBeUndefined();
    expect(idx.getByCitationKey('newKey')?.itemKey).toBe('AAA');
  });

  it('deletes remove items and clear reverse keys', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'foo'), item('BBB', 'bar')]);
    const result = idx.applyPatch([], ['AAA']);

    expect(result.deletes).toEqual(['AAA']);
    expect(idx.getByItemKey('AAA')).toBeUndefined();
    expect(idx.getByCitationKey('foo')).toBeUndefined();
    expect(idx.size()).toBe(1);
  });

  it('phantom deletes (unknown keys) are filtered out', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA')]);
    const result = idx.applyPatch([], ['DOES_NOT_EXIST']);
    expect(result.deletes).toEqual([]);
  });

  it('no-op patch still bumps etag (status broadcast safety)', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA')]);
    const before = idx.getEtag();
    const r = idx.applyPatch([], []);
    expect(r.etag).not.toBe(before);
  });
});

describe('ZoteroIndex / snapshot since', () => {
  it('returns reset:true when no cursor is supplied', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA'), item('BBB')]);
    const snap = idx.buildSnapshotSince();
    expect(snap.reset).toBe(true);
    if (snap.reset) {
      expect(snap.items.map((i) => i.itemKey).sort()).toEqual(['AAA', 'BBB']);
    }
  });

  it('returns a delta when cursor is recent enough', () => {
    const idx = new ZoteroIndex(8);
    idx.hydrate([item('AAA', 'a')]);
    const tagBefore = idx.getEtag();
    idx.applyPatch([item('BBB', 'b')], []);
    idx.applyPatch([], ['AAA']);

    const snap = idx.buildSnapshotSince(tagBefore);
    expect(snap.reset).toBe(false);
    if (!snap.reset) {
      expect(snap.upserts.map((i) => i.itemKey)).toEqual(['BBB']);
      expect(snap.deletes).toEqual(['AAA']);
    }
  });

  it('forces a full reset when cursor predates the bounded delta log', () => {
    const idx = new ZoteroIndex(2);
    idx.hydrate([item('AAA')]);
    const tagAncient = idx.getEtag();
    idx.applyPatch([item('B1')], []);
    idx.applyPatch([item('B2')], []);
    idx.applyPatch([item('B3')], []);

    const snap = idx.buildSnapshotSince(tagAncient);
    expect(snap.reset).toBe(true);
  });
});

describe('ZoteroIndex / searchSync', () => {
  it('finds items by citation key fragment', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([
      item('AAA', 'smith2024', 'Deep Learning'),
      item('BBB', 'jones2023', 'NLP models'),
    ]);

    const hits = idx.searchSync('smit', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.itemKey).toBe('AAA');
  });

  it('returns [] for blank query', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'smith')]);
    expect(idx.searchSync('   ')).toEqual([]);
  });
});
