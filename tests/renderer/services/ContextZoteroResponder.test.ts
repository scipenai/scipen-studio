/**
 * @file ContextZoteroResponder.test.ts
 * @description Dispatch-level tests for the renderer-side responder.
 *   We mock `agentClient` (the IPC bridge) and `getZoteroBibIndex` /
 *   `api.zotero` (the data sources) so the responder's only job under
 *   test is wiring request kinds to handler bodies + snake_case wire
 *   shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above import statements, so any external references
// must go through `vi.hoisted()` to share the same lifted scope.
const mocks = vi.hoisted(() => ({
  onRequestCb: { current: null as ((req: unknown) => void) | null },
  respondMock: vi.fn(async () => ({ ok: true as const })),
  bibSearchMock: vi.fn(),
  bibGetMock: vi.fn(),
  bibGetByCkMock: vi.fn(),
  bibEnsureMock: vi.fn(async () => ({ status: 'ready', count: 0, source: 'bbt' })),
  getCslMock: vi.fn(),
  getAnnotationsMock: vi.fn(),
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

vi.mock('../../../src/renderer/src/services/zotero/ZoteroBibIndex', () => ({
  getZoteroBibIndex: () => ({
    ensureLoaded: mocks.bibEnsureMock,
    search: mocks.bibSearchMock,
    get: mocks.bibGetMock,
    getByCitationKey: mocks.bibGetByCkMock,
  }),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getCslByKey: mocks.getCslMock,
      getItemAnnotations: mocks.getAnnotationsMock,
    },
  },
}));

vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  onRequestCb,
  respondMock,
  bibSearchMock,
  bibGetMock,
  bibGetByCkMock,
  bibEnsureMock,
  getCslMock,
  getAnnotationsMock,
} = mocks;

import { getContextZoteroResponder } from '../../../src/renderer/src/services/agent/ContextZoteroResponder';

describe('ContextZoteroResponder', () => {
  beforeEach(() => {
    respondMock.mockClear();
    bibSearchMock.mockReset();
    bibGetMock.mockReset();
    bibGetByCkMock.mockReset();
    bibEnsureMock.mockClear();
    getCslMock.mockReset();
    getAnnotationsMock.mockReset();
    onRequestCb.current = null;
    getContextZoteroResponder().start();
  });

  afterEach(() => {
    getContextZoteroResponder().stop();
  });

  function send(req: {
    requestId: string;
    kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations';
    params: Record<string, unknown>;
  }): void {
    onRequestCb.current?.(req);
  }

  async function waitForRespond(): Promise<unknown> {
    // Wait one microtask flush for the responder's async handler.
    for (let i = 0; i < 10 && respondMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    return respondMock.mock.calls[0]?.[0];
  }

  describe('zotero_search', () => {
    it('maps BibIndex hits to snake_case wire fields', async () => {
      bibSearchMock.mockResolvedValueOnce([
        {
          itemKey: 'K1',
          citationKey: 'smith2024deep',
          title: 'Deep Learning',
          creatorsLabel: 'Smith',
          year: 2024,
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
      bibSearchMock.mockResolvedValueOnce([]);
      send({ requestId: 'r2', kind: 'zotero_search', params: { query: 'x', limit: 9999 } });
      await waitForRespond();
      expect(bibSearchMock).toHaveBeenCalledWith('x', 50);
    });

    it('defaults limit when caller omits it', async () => {
      bibSearchMock.mockResolvedValueOnce([]);
      send({ requestId: 'r3', kind: 'zotero_search', params: { query: 'x' } });
      await waitForRespond();
      expect(bibSearchMock).toHaveBeenCalledWith('x', 10);
    });
  });

  describe('zotero_lookup', () => {
    it('returns found=false when no entry matches', async () => {
      bibGetByCkMock.mockReturnValueOnce(undefined);
      bibGetMock.mockReturnValueOnce(undefined);
      send({ requestId: 'r4', kind: 'zotero_lookup', params: { key: 'nope' } });
      const reply = await waitForRespond();
      expect(reply).toEqual({ requestId: 'r4', ok: true, data: { found: false } });
    });

    it('returns item with CSL when entry exists and BBT serves CSL', async () => {
      bibGetByCkMock.mockReturnValueOnce({
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

  it('handler throws → fallback ok=false response is sent', async () => {
    bibSearchMock.mockRejectedValueOnce(new Error('worker crashed'));
    send({ requestId: 'r9', kind: 'zotero_search', params: { query: 'x' } });
    const reply = (await waitForRespond()) as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/worker crashed/);
  });
});
