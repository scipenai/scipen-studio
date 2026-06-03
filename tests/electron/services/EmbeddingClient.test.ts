import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  chunkBatches,
  EmbeddingAuthError,
  EmbeddingClient,
  modelIdFor,
  resolveEmbeddingEndpoint,
} from '../../../src/main/services/zotero/EmbeddingClient';

describe('resolveEmbeddingEndpoint', () => {
  it('returns provider default endpoint + model', () => {
    expect(resolveEmbeddingEndpoint('zhipu')).toEqual({
      url: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
      model: 'embedding-3',
    });
    expect(resolveEmbeddingEndpoint('aliyun').model).toBe('text-embedding-v3');
    expect(resolveEmbeddingEndpoint('openai').model).toBe('text-embedding-3-small');
  });

  it('honors model override, ignoring blank', () => {
    expect(resolveEmbeddingEndpoint('zhipu', 'embedding-2').model).toBe('embedding-2');
    expect(resolveEmbeddingEndpoint('zhipu', '   ').model).toBe('embedding-3');
  });
});

describe('modelIdFor', () => {
  it('joins provider and model', () => {
    expect(modelIdFor('zhipu', 'embedding-3')).toBe('zhipu:embedding-3');
  });
});

describe('chunkBatches', () => {
  it('splits into size-bounded chunks preserving order', () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkBatches([], 10)).toEqual([]);
  });
});

describe('EmbeddingClient HTTP', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(vectors: number[][]) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }),
    };
  }

  it('embedOne returns the vector + modelId, sends Bearer auth', async () => {
    fetchMock.mockResolvedValue(okResponse([[0.1, 0.2, 0.3]]));
    const client = new EmbeddingClient({ provider: 'zhipu', apiKey: 'secret-key' });
    const res = await client.embedOne('hello');

    expect(res.vector).toEqual([0.1, 0.2, 0.3]);
    expect(res.modelId).toBe('zhipu:embedding-3');
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'embedding-3', input: ['hello'] });
  });

  it('embedBatch chunks by provider limit and preserves order', async () => {
    // aliyun batch limit = 10; 23 inputs → 3 batches
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      return okResponse(body.input.map((s) => [Number(s)])); // vector encodes its index
    });
    const client = new EmbeddingClient({ provider: 'aliyun', apiKey: 'k' });
    const inputs = Array.from({ length: 23 }, (_, i) => String(i));
    const progress: number[] = [];
    const res = await client.embedBatch(inputs, { onProgress: (d) => progress.push(d) });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.vectors).toHaveLength(23);
    expect(res.vectors.map((v) => v[0])).toEqual(inputs.map(Number)); // order intact
    expect(res.dim).toBe(1);
    expect(progress.at(-1)).toBe(23);
  });

  it('throws EmbeddingAuthError on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const client = new EmbeddingClient({ provider: 'openai', apiKey: 'bad' });
    await expect(client.embedOne('x')).rejects.toBeInstanceOf(EmbeddingAuthError);
  });

  it('throws on count mismatch', async () => {
    fetchMock.mockResolvedValue(okResponse([])); // asked 1, got 0
    const client = new EmbeddingClient({ provider: 'zhipu', apiKey: 'k' });
    await expect(client.embedOne('x')).rejects.toThrow(/count mismatch/);
  });

  it('embedBatch on empty input makes no HTTP call', async () => {
    const client = new EmbeddingClient({ provider: 'zhipu', apiKey: 'k' });
    const res = await client.embedBatch([]);
    expect(res.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
