import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashParagraph } from '../../../shared/utils/sectionExtract';

// ---- mock api / logger ----
const onEmbeddingProgressCb = { current: null as null | ((s: { state: string }) => void) };
const queryMock = vi.fn();
vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      onEmbeddingProgress: (cb: (s: { state: string }) => void) => {
        onEmbeddingProgressCb.current = cb;
        return () => {};
      },
      getEmbeddingStatus: vi.fn(async () => ({ state: 'disabled' })),
      queryRecommendation: (req: { paragraph: string }) => queryMock(req),
    },
  },
}));
vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ActiveRecommendationService } from '../../../src/renderer/src/services/zotero/ActiveRecommendationService';

// ---- fake monaco editor ----
const PARAGRAPH = 'Attention mechanisms reshaped sequence modeling across many tasks.';

function makeEditor(lines: string[], languageId = 'latex') {
  const handlers: { content?: () => void; cursor?: () => void } = {};
  const edits: Array<{ text: string }> = [];
  return {
    edits,
    fireContent: () => handlers.content?.(),
    editor: {
      onDidChangeModelContent: (cb: () => void) => {
        handlers.content = cb;
        return { dispose: () => {} };
      },
      onDidChangeCursorPosition: (cb: () => void) => {
        handlers.cursor = cb;
        return { dispose: () => {} };
      },
      getModel: () => ({
        getLinesContent: () => lines,
        getLanguageId: () => languageId,
        uri: { path: '/x.tex' },
      }),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      executeEdits: (_src: string, ops: Array<{ text: string }>) => {
        edits.push(...ops);
        return true;
      },
      setPosition: () => {},
      focus: () => {},
    },
  };
}

function setReady() {
  onEmbeddingProgressCb.current?.({ state: 'ready' });
}

describe('ActiveRecommendationService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryMock.mockReset();
    queryMock.mockImplementation(async (req: { paragraph: string }) => ({
      items: [{ itemKey: 'AAAA1111', title: 'A', score: 0.9, reranked: false }],
      paragraphHash: hashParagraph(req.paragraph),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('debounces rapid edits into a single query', async () => {
    const h = makeEditor([PARAGRAPH]);
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never);
    setReady();

    h.fireContent();
    h.fireContent();
    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(svc.getState().items).toHaveLength(1);
  });

  it('does not query while index state is not ready', async () => {
    const h = makeEditor([PARAGRAPH]);
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never); // stays 'disabled' (setReady not called)

    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('hash guard skips a second query when paragraph is unchanged', async () => {
    const h = makeEditor([PARAGRAPH]);
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never);
    setReady();

    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);
    expect(queryMock).toHaveBeenCalledTimes(1);

    // cursor moved within the same paragraph → text unchanged → no new query
    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('insertCitation emits language-correct cite text via executeEdits', () => {
    const h = makeEditor([PARAGRAPH], 'typst');
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never);

    svc.insertCitation('smith2024');
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0].text).toBe('@smith2024');
  });

  it('caches citation ranking from scores for @cite reorder', async () => {
    const h = makeEditor([PARAGRAPH]);
    queryMock.mockImplementationOnce(async (req: { paragraph: string }) => ({
      items: [{ itemKey: 'AAAA1111', title: 'A', score: 0.9, reranked: false }],
      paragraphHash: hashParagraph(req.paragraph),
      scores: [
        { citationKey: 'attn2017', score: 0.91 },
        { citationKey: 'gnn2018', score: 0.42 },
      ],
    }));
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never);
    setReady();

    expect(svc.getCitationRanking()).toBeNull(); // 查询前无缓存
    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);

    const ranking = svc.getCitationRanking();
    expect(ranking?.get('attn2017')).toBe(0.91);
    expect(ranking?.get('gnn2018')).toBe(0.42);
  });

  it('retains previous ranking when a later query omits scores', async () => {
    const h = makeEditor([PARAGRAPH]);
    queryMock.mockImplementationOnce(async (req: { paragraph: string }) => ({
      items: [],
      paragraphHash: hashParagraph(req.paragraph),
      scores: [{ citationKey: 'attn2017', score: 0.91 }],
    }));
    const svc = new ActiveRecommendationService();
    svc.attachEditor(h.editor as never);
    setReady();

    h.fireContent();
    await vi.advanceTimersByTimeAsync(1500);
    expect(svc.getCitationRanking()?.get('attn2017')).toBe(0.91);

    // 第二段(不同文本绕过 hash 守卫)→ 查询失败,无 scores → 应保留上次缓存。
    const h2 = makeEditor(['A completely different paragraph about graph theory and topology.']);
    svc.attachEditor(h2.editor as never);
    setReady();
    queryMock.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    h2.fireContent();
    await vi.advanceTimersByTimeAsync(1500);

    expect(svc.getCitationRanking()?.get('attn2017')).toBe(0.91); // 未被清空
  });
});
