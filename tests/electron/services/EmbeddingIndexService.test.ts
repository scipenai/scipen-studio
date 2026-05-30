import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// 隔离 ConfigManager / keychain / Orchestrator 副作用(本测试全用注入 deps)。
vi.mock('../../../src/main/services/ConfigManager', () => ({
  configManager: { get: vi.fn((_k: string, d: unknown) => d) },
}));
vi.mock('../../../src/main/services/SecureStorageService', () => ({
  getZoteroEmbeddingApiKey: vi.fn(() => null),
}));
vi.mock('../../../src/main/services/zotero/ZoteroOrchestrator', () => ({
  getZoteroOrchestrator: () => ({ getIndex: () => ({ values: () => [][Symbol.iterator]() }) }),
}));

import type { ZoteroItemDTO } from '../../../shared/types/zotero';
import { EmbeddingClient } from '../../../src/main/services/zotero/EmbeddingClient';
import { EmbeddingStore } from '../../../src/main/services/zotero/EmbeddingStore';
import { EmbeddingIndexService } from '../../../src/main/services/zotero/EmbeddingIndexService';
import { ZoteroEventBus } from '../../../src/main/services/zotero/ZoteroEventBus';

// ---- 测试替身 ----------------------------------------------------------

function makeItem(
  itemKey: string,
  title: string,
  abstractNote?: string,
  citationKey?: string
): ZoteroItemDTO {
  return { itemKey, itemType: 'journalArticle', title, abstractNote, citationKey };
}

/** 极简 index 替身:只实现 EmbeddingIndexService 用到的 values()/getByItemKey()。 */
class FakeIndex {
  private items = new Map<string, ZoteroItemDTO>();
  set(item: ZoteroItemDTO) {
    this.items.set(item.itemKey, item);
  }
  remove(key: string) {
    this.items.delete(key);
  }
  values(): IterableIterator<ZoteroItemDTO> {
    return this.items.values();
  }
  getByItemKey(key: string): ZoteroItemDTO | undefined {
    return this.items.get(key);
  }
}

/** 确定性 embedding 客户端:向量 = [文本长度, 首字符码],便于断言。 */
class FakeClient {
  modelId = 'zhipu:embedding-3';
  embedCalls: string[][] = [];
  async embedBatch(texts: string[]) {
    this.embedCalls.push(texts);
    return { vectors: texts.map((t) => [t.length, t.charCodeAt(0) || 0]), modelId: this.modelId, dim: 2 };
  }
  async embedOne(text: string) {
    return { vector: [text.length, text.charCodeAt(0) || 0], modelId: this.modelId };
  }
}

interface Harness {
  svc: EmbeddingIndexService;
  index: FakeIndex;
  bus: ZoteroEventBus;
  client: FakeClient;
  store: EmbeddingStore;
  chat: ReturnType<typeof vi.fn>;
}

function makeHarness(
  opts: { enabled?: boolean; apiKey?: string | null; aiConfigured?: boolean; aiBusy?: boolean } = {}
): Harness {
  const index = new FakeIndex();
  const bus = new ZoteroEventBus(() => {}); // 不广播到 BrowserWindow
  const client = new FakeClient();
  const store = new EmbeddingStore();
  // 禁用磁盘 IO,聚焦内存逻辑。
  vi.spyOn(store, 'loadFromDisk').mockResolvedValue(undefined);
  vi.spyOn(store, 'flushToDisk').mockResolvedValue(undefined);

  // 默认 ai 未配置 → recommend 走纯 cosine(cosine-only),与原断言一致。
  const chat = vi.fn().mockResolvedValue('[]');
  const ai = {
    isConfigured: () => opts.aiConfigured ?? false,
    isGenerating: () => opts.aiBusy ?? false,
    chat,
  } as unknown as never;

  const svc = new EmbeddingIndexService({
    index: index as unknown as never,
    bus,
    store,
    ai,
    loadConfig: () => ({
      provider: 'zhipu',
      apiKey: opts.apiKey === undefined ? 'key' : opts.apiKey,
      enabled: opts.enabled ?? true,
    }),
    clientFactory: () => client as unknown as EmbeddingClient,
    now: () => 0,
    flushDebounceMs: 1,
    buildInitialDelayMs: 1,
  });
  svc.start(); // 注册 bus 监听,使增量测试生效
  return { svc, index, bus, client, store, chat };
}

// ---- 测试 --------------------------------------------------------------

describe('EmbeddingIndexService gating', () => {
  it('disabled when activeRecommendation off', async () => {
    const { svc } = makeHarness({ enabled: false });
    await svc.ensureBuilt();
    expect(svc.getStatus().state).toBe('disabled');
  });

  it('no-key when enabled but keychain empty', async () => {
    const { svc } = makeHarness({ enabled: true, apiKey: null });
    await svc.ensureBuilt();
    expect(svc.getStatus().state).toBe('no-key');
  });
});

describe('EmbeddingIndexService build', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds vectors only for items with an abstract', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'Title A', 'abstract about attention'));
    h.index.set(makeItem('BBBB2222', 'Title B')); // 无摘要 → 跳过
    h.index.set(makeItem('CCCC3333', 'Title C', 'abstract about graphs'));

    await h.svc.ensureBuilt();
    const st = h.svc.getStatus();
    expect(st.state).toBe('ready');
    expect(st.total).toBe(2); // 只有 2 条有摘要
    expect(h.store.size()).toBe(2);
    expect(h.store.getModelId()).toBe('zhipu:embedding-3');
  });

  it('recommend returns cosine top-3 with metadata join', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'Attention', 'attention mechanism transformer'));
    h.index.set(makeItem('BBBB2222', 'Graphs', 'graph neural network message passing'));
    await h.svc.ensureBuilt();

    const res = await h.svc.recommend({ paragraph: 'attention', lang: 'latex', filePath: 'x.tex' });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.length).toBeLessThanOrEqual(3);
    expect(res.items[0].title).toBeDefined();
    expect(res.items[0].reranked).toBe(false);
    expect(res.degraded).toBe('cosine-only');
    expect(res.paragraphHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('recommend uses LLM rerank when AI is configured (reason + reranked)', async () => {
    const h = makeHarness({ aiConfigured: true });
    h.index.set(makeItem('AAAA1111', 'Attention', 'attention mechanism transformer'));
    h.index.set(makeItem('BBBB2222', 'Graphs', 'graph neural network'));
    await h.svc.ensureBuilt();
    h.chat.mockResolvedValue('[{"itemKey":"BBBB2222","reason":"graph relevance"}]');

    const res = await h.svc.recommend({ paragraph: 'graphs', lang: 'latex', filePath: 'x.tex' });
    expect(res.degraded).toBeUndefined();
    expect(res.items[0].itemKey).toBe('BBBB2222');
    expect(res.items[0].reason).toBe('graph relevance');
    expect(res.items[0].reranked).toBe(true);
  });

  it('recommend degrades to no-rerank when AI configured but busy', async () => {
    const h = makeHarness({ aiConfigured: true, aiBusy: true });
    h.index.set(makeItem('AAAA1111', 'Attention', 'attention mechanism transformer'));
    await h.svc.ensureBuilt();
    const res = await h.svc.recommend({ paragraph: 'attention', lang: 'latex', filePath: 'x.tex' });
    expect(res.degraded).toBe('no-rerank');
    expect(res.items[0].reranked).toBe(false);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('recommend returns empty when not ready', async () => {
    const { svc } = makeHarness({ enabled: false });
    await svc.ensureBuilt();
    const res = await svc.recommend({ paragraph: 'x', lang: 'latex', filePath: 'x.tex' });
    expect(res.items).toEqual([]);
  });

  it('recommend carries full-library scores mapped to citationKey', async () => {
    const h = makeHarness();
    // 两条有 citationKey、一条无(无 BBT key → 不进 scores)。
    h.index.set(makeItem('AAAA1111', 'Attention', 'attention mechanism transformer', 'attn2017'));
    h.index.set(makeItem('BBBB2222', 'Graphs', 'graph neural network message passing', 'gnn2018'));
    h.index.set(makeItem('CCCC3333', 'NoKey', 'some abstract without a citation key'));
    await h.svc.ensureBuilt();

    const res = await h.svc.recommend({ paragraph: 'attention', lang: 'latex', filePath: 'x.tex' });
    expect(res.scores).toBeDefined();
    // 无 citationKey 的 CCCC3333 被过滤 → 仅 2 条。
    expect(res.scores?.map((s) => s.citationKey).sort()).toEqual(['attn2017', 'gnn2018']);
    // 降序。
    const vals = res.scores?.map((s) => s.score) ?? [];
    expect(vals[0]).toBeGreaterThanOrEqual(vals[1]);
  });

  it('recommend omits scores on failure (renderer keeps last cache)', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'A', 'an abstract', 'a2020'));
    await h.svc.ensureBuilt();
    vi.spyOn(h.client, 'embedOne').mockRejectedValueOnce(new Error('network down'));
    const res = await h.svc.recommend({ paragraph: 'x', lang: 'latex', filePath: 'x.tex' });
    expect(res.items).toEqual([]);
    expect(res.scores).toBeUndefined();
  });
});

describe('EmbeddingIndexService incremental', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hash guard skips re-embed when abstract unchanged', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'A', 'unchanged abstract'));
    await h.svc.ensureBuilt();
    const callsAfterBuild = h.client.embedCalls.length;

    // patch 同一条目、摘要不变 → 不应再 embed
    h.bus.emit({
      kind: 'bib:patch',
      upserts: [makeItem('AAAA1111', 'A', 'unchanged abstract')],
      deletes: [],
      etag: 'e1',
      status: 'ready',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.client.embedCalls.length).toBe(callsAfterBuild); // 无新 embed
  });

  it('re-embeds when abstract changes; removes on delete', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'A', 'old abstract'));
    h.index.set(makeItem('BBBB2222', 'B', 'to be deleted'));
    await h.svc.ensureBuilt();
    expect(h.store.size()).toBe(2);

    // 改摘要 + 删一条
    h.index.set(makeItem('AAAA1111', 'A', 'new longer abstract text'));
    h.index.remove('BBBB2222');
    h.bus.emit({
      kind: 'bib:patch',
      upserts: [makeItem('AAAA1111', 'A', 'new longer abstract text')],
      deletes: ['BBBB2222'],
      etag: 'e2',
      status: 'ready',
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(h.store.has('BBBB2222', '')).toBe(false);
    expect(h.store.size()).toBe(1); // A re-embedded, B removed
  });
});

describe('EmbeddingIndexService invalidate', () => {
  it('clears store and rebuilds', async () => {
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'A', 'some abstract here'));
    await h.svc.ensureBuilt();
    expect(h.store.size()).toBe(1);

    h.svc.invalidate('provider-change');
    await new Promise((r) => setTimeout(r, 5));
    expect(h.svc.getStatus().state).toBe('ready');
  });

  it('manual rebuild refills the store (regression: must not stay empty)', async () => {
    // 回归:invalidate 先 store.clear() 再 ensureBuilt。若 ensureBuilt 的
    // 「ready 且 modelId 未变 → 早退」守卫未失效,build() 会被跳过,库永久停 0。
    const h = makeHarness();
    h.index.set(makeItem('AAAA1111', 'A', 'abstract one'));
    h.index.set(makeItem('BBBB2222', 'B', 'abstract two'));
    await h.svc.ensureBuilt();
    expect(h.store.size()).toBe(2); // 重建前满

    h.svc.invalidate('manual'); // 同 modelId 重建——bug 触发条件
    await new Promise((r) => setTimeout(r, 5));

    expect(h.svc.getStatus().state).toBe('ready');
    expect(h.store.size()).toBe(2); // ← bug 修复前这里是 0(库被清空后没重建)
  });
});
