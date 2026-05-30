/**
 * @file CiteCompletionProvider.test.ts —— 锁定 LaTeX/Markdown/Typst 三种触发位置
 *   的 prefix 提取和 rangeStart 列号计算,以及 @cite 候选的段落语义分层重排。
 *   Monaco 本体不 mock —— 重点是 regex 边界 + 多 key brace 内的分段计算 +
 *   reorderBySemantic 的分层比较逻辑。
 */

import { describe, expect, it, vi } from 'vitest';

// reorderBySemantic 经 getActiveRecommendationService().getCitationRanking() 取分;
// 用一个可切换的 ranking 替身驱动测试(默认 null = 退回原序)。
const rankingRef = { current: null as Map<string, number> | null };
vi.mock('../../../src/renderer/src/services/zotero/ActiveRecommendationService', () => ({
  getActiveRecommendationService: () => ({
    getCitationRanking: () => rankingRef.current,
  }),
}));

import { _internal } from '../../../src/renderer/src/components/editor/CiteCompletionProvider';
import type { BibSearchHit } from '../../../src/renderer/src/services/zotero/bibSearchScoring';
import type { ZoteroItemDTO } from '../../../shared/types/zotero';

/** 用 jsdom 风格的 model stub:仅提供 getValueInRange 拿光标前的子串。 */
function modelStub(lineContent: string) {
  return {
    getValueInRange: (range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }) => lineContent.slice(range.startColumn - 1, range.endColumn - 1),
  } as unknown as Parameters<typeof _internal.detectContext>[0];
}

describe('detectContext —— LaTeX', () => {
  it('triggers right after \\cite{', () => {
    const line = '\\cite{';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('');
    expect(ctx?.rangeStart).toBe(line.length + 1);
  });

  it('captures the running prefix in \\cite{smit', () => {
    const line = '\\cite{smit';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('smit');
    expect(ctx?.rangeStart).toBe(line.length + 1 - 4);
  });

  it('handles multi-key brace \\cite{a, b, c', () => {
    const line = '\\cite{a, b, c';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('c');
    expect(ctx?.rangeStart).toBe(line.length + 1 - 1);
  });

  it('handles \\citep[args]{key variants', () => {
    const line = '\\citep[ch.~3]{jone';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'latex');
    expect(ctx?.prefix).toBe('jone');
  });

  it('returns null when not in cite context', () => {
    expect(
      _internal.detectContext(modelStub('plain text '), pos(12), 'latex')
    ).toBeNull();
  });
});

describe('detectContext —— Markdown', () => {
  it('triggers on [@ prefix', () => {
    const line = '... see [@smith';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('smith');
  });

  it('falls back to bare @key (pandoc, no brackets)', () => {
    const line = 'see @jone';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('jone');
  });

  it('still recognises LaTeX \\cite inside markdown', () => {
    const line = 'see \\cite{thom';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'markdown');
    expect(ctx?.prefix).toBe('thom');
  });
});

describe('detectContext —— Typst', () => {
  it('triggers on @key', () => {
    const line = 'Refer to @carai';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx?.prefix).toBe('carai');
  });

  it('triggers as soon as @x is typed (completion is greedier than hover)', () => {
    const line = '@a';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx?.prefix).toBe('a');
  });

  it('rejects bare @ with no char yet', () => {
    const line = '@';
    const ctx = _internal.detectContext(modelStub(line), pos(line.length + 1), 'typst');
    expect(ctx).toBeNull();
  });
});

function pos(column: number) {
  return { lineNumber: 1, column } as unknown as Parameters<
    typeof _internal.detectContext
  >[1];
}

// ---- reorderBySemantic ------------------------------------------------

function hit(citationKey: string, score: number): BibSearchHit {
  return { item: { itemKey: citationKey, citationKey } as ZoteroItemDTO, score };
}
const keys = (hits: BibSearchHit[]) => hits.map((h) => h.item.citationKey);

describe('reorderBySemantic', () => {
  it('returns input unchanged when no ranking cached (零回归)', () => {
    rankingRef.current = null;
    const hits = [hit('b', 5), hit('a', 3), hit('c', 1)]; // Tier1(token 档)
    expect(_internal.reorderBySemantic(hits)).toBe(hits); // 同一引用,未重排
  });

  it('keeps Tier0 (citation-key 命中) in mirror order regardless of semantic score', () => {
    // 全部 ≥1000 = Tier0;即便语义分把 zzz 抬高,也不得越到 mirror 原序之前。
    rankingRef.current = new Map([
      ['aaa', 0.1],
      ['zzz', 0.99],
    ]);
    const hits = [hit('aaa', 1099), hit('zzz', 1001)];
    expect(keys(_internal.reorderBySemantic(hits))).toEqual(['aaa', 'zzz']);
  });

  it('reorders Tier1 by semantic score descending', () => {
    rankingRef.current = new Map([
      ['low', 0.1],
      ['high', 0.9],
      ['mid', 0.5],
    ]);
    const hits = [hit('low', 5), hit('high', 4), hit('mid', 3)]; // mirror 序与语义序相反
    expect(keys(_internal.reorderBySemantic(hits))).toEqual(['high', 'mid', 'low']);
  });

  it('Tier0 always precedes Tier1 even when Tier1 has higher semantic score', () => {
    rankingRef.current = new Map([
      ['keyhit', 0.0], // Tier0,语义最低
      ['fuzzy', 0.99], // Tier1,语义最高
    ]);
    const hits = [hit('fuzzy', 10), hit('keyhit', 1000)];
    expect(keys(_internal.reorderBySemantic(hits))).toEqual(['keyhit', 'fuzzy']);
  });

  it('sinks unscored (无摘要未嵌入) Tier1 items below scored ones', () => {
    rankingRef.current = new Map([['scored', 0.5]]);
    const hits = [hit('unscored', 5), hit('scored', 4)]; // unscored 无段落分
    expect(keys(_internal.reorderBySemantic(hits))).toEqual(['scored', 'unscored']);
  });
});
