/**
 * @file ContextZoteroResponder.test.ts
 * @description Dispatch-level tests for the renderer-side responder.
 *   Mocks `agentClient` (IPC bridge) and `getZoteroBibMirror` / `api.zotero`
 *   (data sources). The responder's job under test is wiring request kinds
 *   to handler bodies + snake_case wire shapes.
 *
 *   本地用 ZoteroBibMirror(main canonical 镜像)取代远程 ZoteroBibIndex
 *   Worker;mirror 的 search/get 是同步方法,所以 mock 用 mockReturnValue
 *   而不是 mockResolvedValue。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onRequestCb: { current: null as ((req: unknown) => void) | null },
  respondMock: vi.fn(async () => ({ ok: true as const })),
  mirrorSearchMock: vi.fn(),
  mirrorGetByItemKeyMock: vi.fn(),
  mirrorGetByCkMock: vi.fn(),
  getCslMock: vi.fn(),
  getAnnotationsMock: vi.fn(),
  getFullTextMock: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: {
    onContextZoteroRequest: (cb: (req: unknown) => void) => {
      mocks.onRequestCb.current = cb;
      return () => {
        mocks.onRequestCb.current = null;
      };
    },
    respondContextZotero: mocks.respondMock,
  },
}));

vi.mock('../../../src/renderer/src/services/zotero/ZoteroBibMirror', () => ({
  getZoteroBibMirror: () => ({
    searchByQueryWithScore: mocks.mirrorSearchMock,
    getByItemKey: mocks.mirrorGetByItemKeyMock,
    getByCitationKey: mocks.mirrorGetByCkMock,
  }),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getCslByKey: mocks.getCslMock,
      getItemAnnotations: mocks.getAnnotationsMock,
      getFullText: mocks.getFullTextMock,
    },
  },
}));

vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  onRequestCb,
  respondMock,
  mirrorSearchMock,
  mirrorGetByItemKeyMock,
  mirrorGetByCkMock,
  getCslMock,
  getAnnotationsMock,
  getFullTextMock,
} = mocks;

import { getContextZoteroResponder } from '../../../src/renderer/src/services/agent/ContextZoteroResponder';

describe('ContextZoteroResponder', () => {
  beforeEach(() => {
    respondMock.mockClear();
    mirrorSearchMock.mockReset();
    mirrorGetByItemKeyMock.mockReset();
    mirrorGetByCkMock.mockReset();
    getCslMock.mockReset();
    getAnnotationsMock.mockReset();
    getFullTextMock.mockReset();
    onRequestCb.current = null;
    getContextZoteroResponder().start();
  });

  afterEach(() => {
    getContextZoteroResponder().stop();
  });

  function send(req: {
    requestId: string;
    kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations' | 'zotero_read';
    params: Record<string, unknown>;
  }): void {
    onRequestCb.current?.(req);
  }

  async function waitForRespond(): Promise<unknown> {
    for (let i = 0; i < 10 && respondMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    return respondMock.mock.calls[0]?.[0];
  }

  describe('zotero_search', () => {
    it('maps mirror hits to snake_case wire fields', async () => {
      mirrorSearchMock.mockReturnValueOnce([
        {
          item: {
            itemKey: 'K1',
            citationKey: 'smith2024deep',
            title: 'Deep Learning',
            creatorsLabel: 'Smith',
            year: 2024,
          },
          score: 99,
        },
      ]);
      send({ requestId: 'r1', kind: 'zotero_search', params: { query: 'deep' } });
      const reply = await waitForRespond();
      expect(reply).toEqual({
        requestId: 'r1',
        ok: true,
        data: {
          results: [
            {
              item_key: 'K1',
              citation_key: 'smith2024deep',
              title: 'Deep Learning',
              creators_label: 'Smith',
              year: 2024,
              score: 99,
            },
          ],
        },
      });
    });

    it('clamps oversized limit to 50', async () => {
      mirrorSearchMock.mockReturnValueOnce([]);
      send({ requestId: 'r2', kind: 'zotero_search', params: { query: 'x', limit: 9999 } });
      await waitForRespond();
      expect(mirrorSearchMock).toHaveBeenCalledWith('x', 50);
    });

    it('defaults limit when caller omits it', async () => {
      mirrorSearchMock.mockReturnValueOnce([]);
      send({ requestId: 'r3', kind: 'zotero_search', params: { query: 'x' } });
      await waitForRespond();
      expect(mirrorSearchMock).toHaveBeenCalledWith('x', 10);
    });
  });

  describe('zotero_lookup', () => {
    it('returns found=false when no entry matches', async () => {
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      send({ requestId: 'r4', kind: 'zotero_lookup', params: { key: 'nope' } });
      const reply = await waitForRespond();
      expect(reply).toEqual({ requestId: 'r4', ok: true, data: { found: false } });
    });

    it('returns item with CSL when entry exists and BBT serves CSL', async () => {
      mirrorGetByCkMock.mockReturnValueOnce({
        itemKey: 'K1',
        citationKey: 'smith2024',
        title: 'T',
        creatorsLabel: 'Smith',
        year: 2024,
      });
      getCslMock.mockResolvedValueOnce({ id: 'smith2024', type: 'article-journal' });
      send({ requestId: 'r5', kind: 'zotero_lookup', params: { key: 'smith2024' } });
      const reply = (await waitForRespond()) as { data: { item: { csl: unknown } } };
      expect(reply.data.item.csl).toEqual({ id: 'smith2024', type: 'article-journal' });
    });

    it('rejects missing key with ok=false', async () => {
      send({ requestId: 'r6', kind: 'zotero_lookup', params: {} });
      const reply = (await waitForRespond()) as { ok: boolean; error?: string };
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/missing/i);
    });
  });

  describe('zotero_annotations', () => {
    it('maps annotations to snake_case', async () => {
      getAnnotationsMock.mockResolvedValueOnce([
        {
          itemKey: 'ANN1',
          parentItemKey: 'PARENT',
          annotationType: 'highlight',
          annotationText: 'important',
          annotationColor: '#ffd400',
          annotationPageLabel: '5',
        },
      ]);
      send({ requestId: 'r7', kind: 'zotero_annotations', params: { item_key: 'PARENT' } });
      const reply = (await waitForRespond()) as { data: { annotations: unknown[] } };
      expect(reply.data.annotations).toEqual([
        {
          item_key: 'ANN1',
          parent_item_key: 'PARENT',
          annotation_type: 'highlight',
          text: 'important',
          comment: undefined,
          color: '#ffd400',
          page_label: '5',
        },
      ]);
    });

    it('rejects missing item_key', async () => {
      send({ requestId: 'r8', kind: 'zotero_annotations', params: {} });
      const reply = (await waitForRespond()) as { ok: boolean; error?: string };
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/missing/i);
    });
  });

  describe('zotero_read', () => {
    it('resolves key via mirror then relays getFullText result', async () => {
      mirrorGetByCkMock.mockReturnValueOnce({ itemKey: 'K1', citationKey: 'smith2024' });
      getFullTextMock.mockResolvedValueOnce({ text: 'body', truncated: true, tier: 'local' });
      send({ requestId: 'r10', kind: 'zotero_read', params: { key: 'smith2024' } });
      const reply = (await waitForRespond()) as { ok: boolean; data: unknown };
      expect(getFullTextMock).toHaveBeenCalledWith('K1');
      expect(reply.data).toEqual({ text: 'body', truncated: true, tier: 'local' });
    });

    it('returns tier:none when key not in mirror', async () => {
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      send({ requestId: 'r11', kind: 'zotero_read', params: { key: 'nope' } });
      const reply = (await waitForRespond()) as { data: { tier: string } };
      expect(reply.data).toEqual({ text: '', truncated: false, tier: 'none' });
      expect(getFullTextMock).not.toHaveBeenCalled();
    });

    it('rejects missing key', async () => {
      send({ requestId: 'r12', kind: 'zotero_read', params: {} });
      const reply = (await waitForRespond()) as { ok: boolean; error?: string };
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/missing/i);
    });
  });

  it('handler throws → fallback ok=false response is sent', async () => {
    mirrorSearchMock.mockImplementationOnce(() => {
      throw new Error('mirror crashed');
    });
    send({ requestId: 'r9', kind: 'zotero_search', params: { query: 'x' } });
    const reply = (await waitForRespond()) as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/mirror crashed/);
  });
});
