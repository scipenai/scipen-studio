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
  requestRefreshMock: vi.fn(async () => ({ triggered: false, status: 'ready' as const })),
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
      requestRefresh: mocks.requestRefreshMock,
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
  requestRefreshMock,
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
    it('mirror miss returns found=false with reason + fires refresh', async () => {
      // Old behavior: hardcoded { found: false }, LLM cannot tell "no such
      // item" from "possibly stale mirror".
      // New behavior: emit `reason: 'mirror_miss_at_current_snapshot'` so the
      // LLM can distinguish; fire-and-forget requestRefresh so a follow-up
      // call has a chance to hit.
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      requestRefreshMock.mockClear();
      send({ requestId: 'r4', kind: 'zotero_lookup', params: { key: 'nope' } });
      const reply = (await waitForRespond()) as {
        ok: boolean;
        data: { found: boolean; reason?: string };
      };
      expect(reply.ok).toBe(true);
      expect(reply.data.found).toBe(false);
      expect(reply.data.reason).toBe('mirror_miss_at_current_snapshot');
      expect(requestRefreshMock).toHaveBeenCalledOnce();
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

    it('mirror miss + web_pending — reason NOT emitted (sentinel already disambiguates)', async () => {
      // Mirror miss falls through to handler with raw key; web mode facade
      // returns `tier:'web_pending'` which is itself a strong sentinel
      // ("PDF is in cloud, deferred to stage B"). Adding
      // `reason:'unresolved_key'` on top would be redundant — the LLM
      // already knows exactly why there's no text.
      // Reason is a tier='none' disambiguator; web_pending doesn't need it.
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      getFullTextMock.mockResolvedValueOnce({
        text: '',
        truncated: false,
        tier: 'web_pending',
      });
      send({ requestId: 'r11', kind: 'zotero_read', params: { key: 'nope' } });
      const reply = (await waitForRespond()) as {
        data: { tier: string; reason?: string };
      };
      // Handler DID run with the raw key (facade returns the honest sentinel).
      expect(getFullTextMock).toHaveBeenCalledWith('nope');
      expect(reply.data.tier).toBe('web_pending');
      expect(reply.data.reason).toBeUndefined();
    });

    it('mirror miss + tier=none — reason:unresolved_key IS emitted (needs disambiguation)', async () => {
      // The disambiguation-critical case: local mode, mirror miss, raw key
      // fell through to fullTextService, no PDF found → tier:'none'. Without
      // the reason field, the LLM cannot tell "genuine no PDF" from
      // "unresolved key". reason='unresolved_key' tells it to retry with a
      // canonical key instead of concluding the paper has no content.
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      getFullTextMock.mockResolvedValueOnce({
        text: '',
        truncated: false,
        tier: 'none',
      });
      send({ requestId: 'r15', kind: 'zotero_read', params: { key: 'nope' } });
      const reply = (await waitForRespond()) as {
        data: { tier: string; reason?: string };
      };
      expect(reply.data.tier).toBe('none');
      expect(reply.data.reason).toBe('unresolved_key');
    });

    it('mirror hit — reason field is undefined (regular resolved path)', async () => {
      mirrorGetByCkMock.mockReturnValueOnce({ itemKey: 'K2', citationKey: 'x2024' });
      getFullTextMock.mockResolvedValueOnce({ text: 'body', truncated: false, tier: 'local' });
      send({ requestId: 'r13', kind: 'zotero_read', params: { key: 'x2024' } });
      const reply = (await waitForRespond()) as { data: { reason?: string } };
      expect(reply.data.reason).toBeUndefined();
    });

    it('mirror miss BUT tier=local — reason NOT emitted (no contradictory signal)', async () => {
      // Edge case: raw key falls through to handler because mirror missed,
      // but the raw key happens to be a valid itemKey (agent guessed right
      // or mirror is stale) and getFullText returned real text with tier:'local'.
      // Emitting reason:'unresolved_key' alongside `tier:'local' + text:'body'`
      // would confuse the LLM (valid text vs "unresolved key"). Only emit
      // reason when tier is 'none' (i.e. actually needs disambiguation).
      mirrorGetByCkMock.mockReturnValueOnce(undefined);
      mirrorGetByItemKeyMock.mockReturnValueOnce(undefined);
      getFullTextMock.mockResolvedValueOnce({
        text: 'body',
        truncated: false,
        tier: 'local',
      });
      send({ requestId: 'r14', kind: 'zotero_read', params: { key: 'RAWKEY123' } });
      const reply = (await waitForRespond()) as { data: { reason?: string; tier: string } };
      expect(reply.data.tier).toBe('local');
      expect(reply.data.reason).toBeUndefined();
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
