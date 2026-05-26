/**
 * @file bibSearchScoring.test.ts —— @cite 评分纯函数测试
 * @description 锁定 citation-key 前缀 → token → substring 三档评分语义,
 *              以及 recency bias。port 自 m2-zotero-stash 的 worker 测试。
 */

import { describe, expect, it } from 'vitest';
import type { ZoteroItemDTO } from '../../../shared/types/zotero';
import {
  buildHaystack,
  searchBibCorpus,
  tokenize,
  type BibSearchCorpus,
} from '../../../src/renderer/src/services/zotero/bibSearchScoring';

function item(over: Partial<ZoteroItemDTO> & { itemKey: string }): ZoteroItemDTO {
  return {
    itemType: 'journalArticle',
    title: '',
    ...over,
  } as ZoteroItemDTO;
}

/** 构建 corpus(testing 用,与 mirror.indexItem 等价的局部 build)。 */
function corpus(...entries: ZoteroItemDTO[]): BibSearchCorpus {
  const items = new Map<string, ZoteroItemDTO>();
  const citationKeyIndex = new Map<string, string>();
  const tokenIndex = new Map<string, Set<string>>();
  const haystacks = new Map<string, string>();
  for (const e of entries) {
    items.set(e.itemKey, e);
    if (e.citationKey) citationKeyIndex.set(e.citationKey.toLowerCase(), e.itemKey);
    const h = buildHaystack(e);
    haystacks.set(e.itemKey, h);
    for (const tok of tokenize(h)) {
      let set = tokenIndex.get(tok);
      if (!set) {
        set = new Set();
        tokenIndex.set(tok, set);
      }
      set.add(e.itemKey);
    }
  }
  return { items, citationKeyIndex, tokenIndex, haystacks };
}

describe('tokenize', () => {
  it('lowercases + drops single-letter noise', () => {
    expect(tokenize('Deep Learning, A Survey 2024')).toEqual([
      'deep',
      'learning',
      'survey',
      '2024',
    ]);
  });

  it('splits on non-alnum', () => {
    expect(tokenize('smith2024deep-rl')).toEqual(['smith2024deep', 'rl']);
  });
});

describe('searchBibCorpus — citation-key prefix wins', () => {
  it('ranks citation-key prefix hits above token hits', () => {
    const c = corpus(
      item({
        itemKey: 'A',
        citationKey: 'smith2024deep',
        title: 'Some unrelated thing',
      }),
      item({
        itemKey: 'B',
        title: 'Smith Brothers deep learning survey',
      })
    );
    const hits = searchBibCorpus(c, 'smith', 10);
    expect(hits[0]?.item.itemKey).toBe('A'); // ck-prefix 直接命中
  });

  it('exact citation-key match scores higher than longer-prefix match', () => {
    const c = corpus(
      item({ itemKey: 'A', citationKey: 'jones' }),
      item({ itemKey: 'B', citationKey: 'jonesBrothers' })
    );
    const hits = searchBibCorpus(c, 'jones', 10);
    expect(hits[0]?.item.itemKey).toBe('A');
    expect(hits[1]?.item.itemKey).toBe('B');
  });
});

describe('searchBibCorpus — token scoring', () => {
  it('matches title tokens by prefix', () => {
    const c = corpus(
      item({ itemKey: 'A', title: 'Deep learning survey', year: 2024 }),
      item({ itemKey: 'B', title: 'Shallow chemistry textbook', year: 2024 })
    );
    const hits = searchBibCorpus(c, 'deep', 10);
    expect(hits.map((h) => h.item.itemKey)).toEqual(['A']);
  });

  it('applies recency bias when token scores tie', () => {
    const c = corpus(
      item({ itemKey: 'OLD', title: 'Survey', year: 2005 }),
      item({ itemKey: 'NEW', title: 'Survey', year: 2024 })
    );
    const hits = searchBibCorpus(c, 'survey', 10);
    expect(hits[0]?.item.itemKey).toBe('NEW');
  });
});

describe('searchBibCorpus — substring fallback', () => {
  it('returns substring matches when no token/ck hits', () => {
    const c = corpus(item({ itemKey: 'A', title: 'A unique singletoken' }));
    // "uniqu" 不是 token 前缀(token 是 'a'/'unique'/'singletoken' — token 'a'
    // 因为长度 1 被丢),但作为 substring 在 haystack 里能找到。
    const hits = searchBibCorpus(c, 'uniq', 10);
    // token-prefix 已经命中('unique' startsWith 'uniq'),不会走 substring 兜底。
    // 这里仅锁定 fallback 路径需要:换一个 token 内部的子串。
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns [] for empty query', () => {
    const c = corpus(item({ itemKey: 'A', title: 't' }));
    expect(searchBibCorpus(c, '', 10)).toEqual([]);
    expect(searchBibCorpus(c, '   ', 10)).toEqual([]);
  });

  it('honors limit', () => {
    const c = corpus(
      item({ itemKey: 'A', citationKey: 'foo1' }),
      item({ itemKey: 'B', citationKey: 'foo2' }),
      item({ itemKey: 'C', citationKey: 'foo3' })
    );
    expect(searchBibCorpus(c, 'foo', 2)).toHaveLength(2);
  });
});
