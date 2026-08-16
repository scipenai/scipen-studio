/**
 * @file ZoteroOrchestrator.test.ts
 * @description Covers the state machine + source merging behaviour of
 *   the canonical orchestrator. Mocks both BBT and LocalApi clients so
 *   we can exercise all four legs of the truth table:
 *     LocalApi ok    + BBT ok    → ready
 *     LocalApi ok    + BBT fail  → degraded
 *     LocalApi fail  + BBT ok    → error (no metadata source)
 *     LocalApi fail  + BBT fail  → error
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ConfigManager / SecureStorageService / CitationKeyStore side-effect isolation
// is handled globally in tests/renderer/setup.ts — do not re-declare here.

import {
  ZoteroOrchestrator,
  mergeBbtIntoItems,
  diffAgainstIndex,
} from '../../../src/main/services/zotero/ZoteroOrchestrator';
import { ZoteroIndex } from '../../../src/main/services/zotero/ZoteroIndex';
import { ZoteroEventBus } from '../../../src/main/services/zotero/ZoteroEventBus';
import type { ZoteroItemDTO, ZoteroPingResultDTO } from '../../../shared/types/zotero';
import type { ZoteroEventDTO } from '../../../shared/types/zotero-events';

interface FakeLocalApi {
  ping: () => Promise<ZoteroPingResultDTO>;
  getAllItems: () => Promise<ZoteroItemDTO[]>;
}
interface FakeBbt {
  /** 主路径仅用 ping —— citationKey 由 LocalApi 从 data.citationKey 直接拿。 */
  ping: () => Promise<{ ok: boolean; version?: string; error?: string }>;
}

function makeOrchestrator(
  local: Partial<FakeLocalApi>,
  bbt: Partial<FakeBbt>,
  opts: { events?: ZoteroEventDTO[] } = {}
): ZoteroOrchestrator {
  const events = opts.events ?? [];
  const bus = new ZoteroEventBus((_channel, payload) => {
    events.push(payload as ZoteroEventDTO);
  });
  const index = new ZoteroIndex();
  return new ZoteroOrchestrator({
    localApi: {
      ping: local.ping ?? (async () => ({ ok: true, version: 7 })),
      getAllItems: local.getAllItems ?? (async () => []),
    } as never,
    bbt: {
      ping: bbt.ping ?? (async () => ({ ok: true, version: '7.0' })),
    } as never,
    bus,
    index,
    now: () => 1_700_000_000_000,
  });
}

function item(itemKey: string, title = `Paper ${itemKey}`, citationKey?: string): ZoteroItemDTO {
  return {
    itemKey,
    itemType: 'journalArticle',
    title,
    creatorsLabel: 'Doe',
    year: 2024,
    citationKey,
  };
}

describe('ZoteroOrchestrator / bootstrap', () => {
  it('LocalApi ok + BBT ok → status ready, items carry citation keys (LocalApi-injected)', async () => {
    const events: ZoteroEventDTO[] = [];
    const orch = makeOrchestrator(
      {
        // citationKey 由 LocalApi 从 data.citationKey 拿来,直接出现在 DTO 上 ——
        // 不再需要 BBT RPC 后置合并。
        getAllItems: async () => [
          item('AAA', 'Deep Learning', 'smith2024'),
          item('BBB', 'Chemistry', 'jones2023'),
        ],
      },
      {},
      { events }
    );

    const result = await orch.bootstrap();
    expect(result.status).toBe('ready');
    expect(orch.getDiagnostics().sources.betterBibTex.ok).toBe(true);
    expect(orch.getIndex().getByCitationKey('smith2024')?.itemKey).toBe('AAA');

    // Renderer should see a bib:initial event.
    expect(events.some((e) => e.kind === 'bib:initial')).toBe(true);
  });

  it('LocalApi ok + BBT ping fail → degraded (items still indexed, ck depends on data)', async () => {
    const events: ZoteroEventDTO[] = [];
    const orch = makeOrchestrator(
      { getAllItems: async () => [item('AAA')] },
      {
        ping: async () => ({ ok: false, error: 'BBT not installed' }),
      },
      { events }
    );

    const result = await orch.bootstrap();
    expect(result.status).toBe('degraded');
    expect(orch.getDiagnostics().sources.betterBibTex.ok).toBe(false);
    // 没装 BBT,LocalApi 的 data.citationKey 也是 undefined → DTO.citationKey 也无。
    expect(orch.getIndex().getByItemKey('AAA')?.citationKey).toBeUndefined();
  });

  it('LocalApi fail → status error, index left empty, status broadcast', async () => {
    const events: ZoteroEventDTO[] = [];
    const orch = makeOrchestrator(
      { ping: async () => ({ ok: false, error: 'ECONNREFUSED' }) },
      {},
      { events }
    );

    const result = await orch.bootstrap();
    expect(result.status).toBe('error');
    expect(orch.getIndex().size()).toBe(0);
    expect(events.some((e) => e.kind === 'bib:status' && e.status === 'error')).toBe(true);
  });

  it('bootstrap is a no-op when already ready', async () => {
    let calls = 0;
    const orch = makeOrchestrator(
      {
        getAllItems: async () => {
          calls++;
          return [item('AAA')];
        },
      },
      {}
    );
    await orch.bootstrap();
    await orch.bootstrap(); // second call should short-circuit
    expect(calls).toBe(1);
  });
});

describe('ZoteroOrchestrator / refresh + cooldown', () => {
  it('skips refresh inside the cooldown window', async () => {
    let calls = 0;
    let now = 1_000_000;
    const bus = new ZoteroEventBus(() => {});
    const orch = new ZoteroOrchestrator({
      localApi: {
        ping: async () => ({ ok: true, version: 7 }),
        getAllItems: async () => {
          calls++;
          return [item('AAA')];
        },
      } as never,
      bbt: { ping: async () => ({ ok: true, version: '7.0' }) } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => now,
    });
    await orch.bootstrap();
    expect(calls).toBe(1);

    now += 500; // < REFRESH_COOLDOWN_MS
    const r1 = await orch.refresh('focus');
    expect(r1.triggered).toBe(false);
    expect(calls).toBe(1);

    now += 2000; // > cooldown
    const r2 = await orch.refresh('focus');
    expect(r2.triggered).toBe(true);
    expect(calls).toBe(2);
  });

  it('refresh emits bib:patch when content changed', async () => {
    let nth = 0;
    const events: ZoteroEventDTO[] = [];
    let now = 1_000_000;
    const bus = new ZoteroEventBus((_channel, payload) => {
      events.push(payload as ZoteroEventDTO);
    });
    const orch = new ZoteroOrchestrator({
      localApi: {
        ping: async () => ({ ok: true, version: 7 }),
        getAllItems: async () => {
          nth++;
          return nth === 1 ? [item('AAA')] : [item('AAA'), item('BBB')];
        },
      } as never,
      bbt: { ping: async () => ({ ok: true, version: '7.0' }) } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => now,
    });

    await orch.bootstrap();
    expect(events.some((e) => e.kind === 'bib:initial')).toBe(true);

    now += 5000;
    await orch.refresh('manual');
    const patch = events.find((e) => e.kind === 'bib:patch');
    expect(patch).toBeDefined();
    if (patch && patch.kind === 'bib:patch') {
      expect(patch.upserts.map((i) => i.itemKey)).toEqual(['BBB']);
      expect(patch.deletes).toEqual([]);
    }
  });
});

describe('mergeBbtIntoItems', () => {
  it('attaches citation keys when itemKey matches', () => {
    const items = [item('AAA'), item('BBB')];
    const merged = mergeBbtIntoItems(
      items,
      new Map([
        ['AAA', 'smith2024'],
        ['CCC', 'orphan'], // doesn't apply
      ])
    );
    expect(merged[0]?.citationKey).toBe('smith2024');
    expect(merged[1]?.citationKey).toBeUndefined();
  });

  it('passes through unchanged when no keys', () => {
    const items = [item('AAA')];
    expect(mergeBbtIntoItems(items, new Map())).toBe(items);
  });
});

describe('ZoteroOrchestrator / web mode + 3-layer citation key normalization', () => {
  interface FakeWebApi {
    ping: () => Promise<{ ok: boolean; username?: string; error?: string }>;
    getAllItems: () => Promise<ZoteroItemDTO[]>;
  }
  interface FakeStore {
    get: (
      itemKey: string
    ) => { key: string; origin: 'bbt' | 'studio_mint' | 'user_override' } | null;
    put: ReturnType<typeof vi.fn>;
    updateFromBbt: ReturnType<typeof vi.fn>;
    getAllExistingKeys: () => Set<string>;
  }

  function makeWebOrchestrator(
    web: Partial<FakeWebApi>,
    store: Partial<FakeStore> = {},
    opts: { events?: ZoteroEventDTO[] } = {}
  ): { orch: ZoteroOrchestrator; store: FakeStore } {
    const events = opts.events ?? [];
    const bus = new ZoteroEventBus((_channel, payload) => {
      events.push(payload as ZoteroEventDTO);
    });
    const fullStore: FakeStore = {
      get: store.get ?? (() => null),
      put: store.put ?? vi.fn(),
      updateFromBbt: store.updateFromBbt ?? vi.fn(),
      getAllExistingKeys: store.getAllExistingKeys ?? (() => new Set<string>()),
    };
    const orch = new ZoteroOrchestrator({
      localApi: {
        ping: async () => ({ ok: false, error: 'not used' }),
        getAllItems: async () => [],
      } as never,
      bbt: { ping: async () => ({ ok: false }) } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => 1_700_000_000_000,
      keyStore: fullStore as never,
      getWebApiClient: () =>
        ({
          ping: web.ping ?? (async () => ({ ok: true, username: 'alice' })),
          getAllItems: web.getAllItems ?? (async () => []),
        }) as never,
      getSettings: () => ({ dataSource: 'web', webApiUserId: '123456', hasWebApiKey: true }),
    });
    return { orch, store: fullStore };
  }

  it('layer 1: BBT-synced citationKey wins + persists via updateFromBbt', async () => {
    const events: ZoteroEventDTO[] = [];
    const { orch, store } = makeWebOrchestrator(
      {
        getAllItems: async () => [item('AAA', 'Deep Learning', 'smith2024deep')],
      },
      {},
      { events }
    );
    await orch.bootstrap();
    const stored = orch.getIndex().getByItemKey('AAA');
    expect(stored?.citationKey).toBe('smith2024deep');
    expect(stored?.citationKeyOrigin).toBe('bbt');
    expect(store.updateFromBbt).toHaveBeenCalledWith('AAA', 'smith2024deep');
    expect(store.put).not.toHaveBeenCalled();
  });

  it('layer 2: store hit preserves stored origin (user_override / studio_mint)', async () => {
    const { orch, store } = makeWebOrchestrator(
      {
        getAllItems: async () => [item('AAA', 'Deep Learning', undefined)],
      },
      {
        get: (k) => (k === 'AAA' ? { key: 'custom_key_from_user', origin: 'user_override' } : null),
      }
    );
    await orch.bootstrap();
    const stored = orch.getIndex().getByItemKey('AAA');
    expect(stored?.citationKey).toBe('custom_key_from_user');
    expect(stored?.citationKeyOrigin).toBe('user_override');
    expect(store.put).not.toHaveBeenCalled();
  });

  it('layer 3: minter runs + result persisted as studio_mint', async () => {
    const { orch, store } = makeWebOrchestrator(
      {
        getAllItems: async () => [
          { ...item('AAA', 'Deep Learning', undefined), creatorsLabel: 'Smith' },
        ],
      },
      {
        get: () => null,
        getAllExistingKeys: () => new Set(),
      }
    );
    await orch.bootstrap();
    const stored = orch.getIndex().getByItemKey('AAA');
    expect(stored?.citationKey).toBe('smith2024deep');
    expect(stored?.citationKeyOrigin).toBe('studio_mint');
    expect(store.put).toHaveBeenCalledWith('AAA', 'smith2024deep', 'studio_mint');
  });

  it('layer 1 dup: two items with same BBT key resolve via mint fallback', async () => {
    // Two Zotero items both carry the same data.citationKey (rare, but users
    // can hand-edit). Layer 1 alone would echo the duplicate; the !existing.has
    // guard forces the second collision through Layer 3 minting.
    const { orch, store } = makeWebOrchestrator(
      {
        getAllItems: async () => [
          { ...item('AAA', 'Deep Learning', 'smith2024deep'), creatorsLabel: 'Smith' },
          { ...item('BBB', 'Deep Learning', 'smith2024deep'), creatorsLabel: 'Smith' },
        ],
      },
      { get: () => null, getAllExistingKeys: () => new Set() }
    );
    await orch.bootstrap();
    const a = orch.getIndex().getByItemKey('AAA');
    const b = orch.getIndex().getByItemKey('BBB');
    expect(a?.citationKey).toBe('smith2024deep');
    expect(a?.citationKeyOrigin).toBe('bbt');
    // Second item falls through: existing already has smith2024deep, mints postfix.
    expect(b?.citationKey).toBe('smith2024deepa');
    expect(b?.citationKeyOrigin).toBe('studio_mint');
    // Only the first (successful BBT) call reconciled the store.
    expect(store.updateFromBbt).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledWith('BBB', 'smith2024deepa', 'studio_mint');
  });

  it('sqlite failure in getAllExistingKeys falls through to pass-through items', async () => {
    const failingStore: FakeStore = {
      get: () => null,
      put: vi.fn(),
      updateFromBbt: vi.fn(),
      getAllExistingKeys: () => {
        throw new Error('database disk image is malformed');
      },
    };
    const bus = new ZoteroEventBus(() => undefined);
    const orch = new ZoteroOrchestrator({
      localApi: {
        ping: async () => ({ ok: false }),
        getAllItems: async () => [],
      } as never,
      bbt: { ping: async () => ({ ok: false }) } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => 1_700_000_000_000,
      keyStore: failingStore as never,
      getWebApiClient: () =>
        ({
          ping: async () => ({ ok: true, username: 'alice' }),
          getAllItems: async () => [item('AAA', 'Deep Learning', 'smith2024deep')],
        }) as never,
      getSettings: () => ({ dataSource: 'web', webApiUserId: '123456', hasWebApiKey: true }),
    });
    const result = await orch.bootstrap();
    // Refresh completes despite the sqlite failure; items pass through unnormalized.
    expect(result.status).toBe('ready');
    const stored = orch.getIndex().getByItemKey('AAA');
    // Original data.citationKey preserved (Layer 1/2/3 never ran).
    expect(stored?.citationKey).toBe('smith2024deep');
    expect(stored?.citationKeyOrigin).toBeUndefined();
  });

  it('layer 3 batch: two minted items in same refresh do not collide', async () => {
    const { orch } = makeWebOrchestrator({
      getAllItems: async () => [
        {
          ...item('AAA', 'Deep Learning', undefined),
          creatorsLabel: 'Smith',
        },
        {
          // Same year + author + title tail as AAA — collision must resolve
          // via the in-batch `minted` set (both entries persisted separately).
          ...item('BBB', 'Deep Learning', undefined),
          creatorsLabel: 'Smith',
        },
      ],
    });
    await orch.bootstrap();
    const a = orch.getIndex().getByItemKey('AAA');
    const b = orch.getIndex().getByItemKey('BBB');
    expect(a?.citationKey).toBe('smith2024deep');
    expect(b?.citationKey).toBe('smith2024deepa');
  });

  it('web mode: BBT probe reported as skipped in diagnostics', async () => {
    const { orch } = makeWebOrchestrator({
      getAllItems: async () => [item('AAA', 'X', 'x')],
    });
    await orch.bootstrap();
    const diag = orch.getDiagnostics();
    expect(diag.sources.web?.ok).toBe(true);
    expect(diag.sources.betterBibTex.detail).toMatch(/skipped in web/);
    expect(diag.sources.localApi.detail).toMatch(/skipped in web/);
  });

  it('web mode fetch failure surfaces as error status (index stays warm)', async () => {
    const { orch } = makeWebOrchestrator({
      ping: async () => ({ ok: false, error: 'invalid api key' }),
    });
    const result = await orch.bootstrap();
    expect(result.status).toBe('error');
    expect(orch.getDiagnostics().sources.web?.ok).toBe(false);
    expect(orch.getDiagnostics().sources.web?.error).toMatch(/invalid api key/);
  });

  it('web mode without configured client returns descriptive error', async () => {
    const bus = new ZoteroEventBus(() => {});
    const orch = new ZoteroOrchestrator({
      localApi: {
        ping: async () => ({ ok: false }),
        getAllItems: async () => [],
      } as never,
      bbt: { ping: async () => ({ ok: false }) } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => 1_700_000_000_000,
      getWebApiClient: () => null, // no credentials
      getSettings: () => ({ dataSource: 'web', webApiUserId: '', hasWebApiKey: false }),
    });
    const result = await orch.bootstrap();
    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/not configured/i);
  });
});

describe('diffAgainstIndex', () => {
  it('detects upserts (new + content-changed) and deletes', () => {
    const idx = new ZoteroIndex();
    idx.hydrate([item('AAA', 'Original'), item('BBB', 'Bee')]);
    const next = [item('AAA', 'Renamed'), item('CCC', 'See')];
    const { upserts, deletes } = diffAgainstIndex(idx, next);
    expect(upserts.map((i) => i.itemKey).sort()).toEqual(['AAA', 'CCC']);
    expect(deletes).toEqual(['BBB']);
  });

  it('emits no diff when content is identical', () => {
    const idx = new ZoteroIndex();
    const seed = [item('AAA'), item('BBB')];
    idx.hydrate(seed);
    const { upserts, deletes } = diffAgainstIndex(idx, [item('AAA'), item('BBB')]);
    expect(upserts).toEqual([]);
    expect(deletes).toEqual([]);
  });
});
