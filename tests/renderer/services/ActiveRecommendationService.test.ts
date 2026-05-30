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
});
