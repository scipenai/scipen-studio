import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildRerankPrompt,
  parseRerankResponse,
  rerankCandidates,
  type RerankCandidate,
} from '../../../src/main/services/zotero/EmbeddingRerank';
import type { IAIService } from '../../../src/main/services/interfaces/IAIService';

const CANDS: RerankCandidate[] = [
  {
    itemKey: 'AAAA1111',
    title: 'Attention',
    abstract: 'transformer self-attention',
    cosineScore: 0.9,
  },
  { itemKey: 'BBBB2222', title: 'Graphs', abstract: 'message passing', cosineScore: 0.7 },
];

describe('buildRerankPrompt', () => {
  it('includes paragraph + numbered candidates with itemKeys', () => {
    const p = buildRerankPrompt('writing about attention', CANDS, 'latex');
    expect(p).toContain('[PARAGRAPH]');
    expect(p).toContain('writing about attention');
    expect(p).toContain('itemKey=AAAA1111');
    expect(p).toContain('itemKey=BBBB2222');
  });
});

describe('parseRerankResponse', () => {
  it('parses a clean JSON array, preserving order', () => {
    const raw =
      '[{"itemKey":"BBBB2222","reason":"graph focus"},{"itemKey":"AAAA1111","reason":"attn"}]';
    const out = parseRerankResponse(raw, CANDS);
    expect(out).toEqual([
      { itemKey: 'BBBB2222', reason: 'graph focus' },
      { itemKey: 'AAAA1111', reason: 'attn' },
    ]);
  });

  it('extracts JSON embedded in prose', () => {
    const raw = 'Sure! Here you go:\n[{"itemKey":"AAAA1111","reason":"x"}]\nHope that helps.';
    expect(parseRerankResponse(raw, CANDS)).toEqual([{ itemKey: 'AAAA1111', reason: 'x' }]);
  });

  it('filters out itemKeys not in candidate set + dedups', () => {
    const raw =
      '[{"itemKey":"ZZZZ9999","reason":"x"},{"itemKey":"AAAA1111","reason":"y"},{"itemKey":"AAAA1111","reason":"dup"}]';
    expect(parseRerankResponse(raw, CANDS)).toEqual([{ itemKey: 'AAAA1111', reason: 'y' }]);
  });

  it('returns null on invalid JSON / no array / all-filtered', () => {
    expect(parseRerankResponse('not json', CANDS)).toBeNull();
    expect(parseRerankResponse('{"itemKey":"AAAA1111"}', CANDS)).toBeNull();
    expect(parseRerankResponse('[{"itemKey":"ZZZZ9999"}]', CANDS)).toBeNull();
  });
});

function fakeAi(over: Partial<IAIService>): IAIService {
  return {
    isConfigured: () => true,
    isGenerating: () => false,
    chat: vi.fn(),
    ...over,
  } as unknown as IAIService;
}

describe('rerankCandidates degradation', () => {
  it('returns null when AI not configured', async () => {
    const ai = fakeAi({ isConfigured: () => false });
    expect(await rerankCandidates(ai, 'p', CANDS, 'latex')).toBeNull();
  });

  it('returns null when AI is generating (busy)', async () => {
    const ai = fakeAi({ isGenerating: () => true });
    expect(await rerankCandidates(ai, 'p', CANDS, 'latex')).toBeNull();
  });

  it('returns null when chat throws', async () => {
    const ai = fakeAi({ chat: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await rerankCandidates(ai, 'p', CANDS, 'latex')).toBeNull();
  });

  it('returns parsed ranking on success', async () => {
    const ai = fakeAi({
      chat: vi.fn().mockResolvedValue('[{"itemKey":"BBBB2222","reason":"r"}]'),
    });
    expect(await rerankCandidates(ai, 'p', CANDS, 'latex')).toEqual([
      { itemKey: 'BBBB2222', reason: 'r' },
    ]);
  });

  it('returns null for empty candidates without calling chat', async () => {
    const chat = vi.fn();
    const ai = fakeAi({ chat });
    expect(await rerankCandidates(ai, 'p', [], 'latex')).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});
