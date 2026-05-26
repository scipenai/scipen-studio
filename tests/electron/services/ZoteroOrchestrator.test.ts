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
  getAllCitations: () => Promise<Array<{ citationKey: string; itemKey: string; libraryID: number }>>;
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
      getAllCitations: bbt.getAllCitations ?? (async () => []),
    } as never,
    bus,
    index,
    now: () => 1_700_000_000_000,
  });
}

function item(itemKey: string, title = `Paper ${itemKey}`): ZoteroItemDTO {
  return {
    itemKey,
    itemType: 'journalArticle',
    title,
    creatorsLabel: 'Doe',
    year: 2024,
  };
}

describe('ZoteroOrchestrator / bootstrap', () => {
  it('LocalApi ok + BBT ok → status ready and items merged with citation keys', async () => {
    const events: ZoteroEventDTO[] = [];
    const orch = makeOrchestrator(
      {
        getAllItems: async () => [item('AAA'), item('BBB')],
      },
      {
        getAllCitations: async () => [
          { citationKey: 'smith2024', itemKey: 'AAA', libraryID: 1 },
          { citationKey: 'jones2023', itemKey: 'BBB', libraryID: 1 },
        ],
      },
      { events }
    );

    const result = await orch.bootstrap();
    expect(result.status).toBe('ready');
    expect(orch.getDiagnostics().sources.betterBibTex.ok).toBe(true);
    expect(orch.getIndex().getByCitationKey('smith2024')?.itemKey).toBe('AAA');

    // Renderer should see a bib:initial event.
    expect(events.some((e) => e.kind === 'bib:initial')).toBe(true);
  });

  it('LocalApi ok + BBT fail → degraded with items but no citation keys', async () => {
    const events: ZoteroEventDTO[] = [];
    const orch = makeOrchestrator(
      { getAllItems: async () => [item('AAA')] },
      {
        getAllCitations: async () => {
          throw new Error('BBT not installed');
        },
      },
      { events }
    );

    const result = await orch.bootstrap();
    expect(result.status).toBe('degraded');
    expect(orch.getDiagnostics().sources.betterBibTex.ok).toBe(false);
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
    await orch.bootstrap();  // second call should short-circuit
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
      bbt: { getAllCitations: async () => [] } as never,
      bus,
      index: new ZoteroIndex(),
      now: () => now,
    });
    await orch.bootstrap();
    expect(calls).toBe(1);

    now += 500;  // < REFRESH_COOLDOWN_MS
    const r1 = await orch.refresh('focus');
    expect(r1.triggered).toBe(false);
    expect(calls).toBe(1);

    now += 2000;  // > cooldown
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
      bbt: { getAllCitations: async () => [] } as never,
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
        ['CCC', 'orphan'],  // doesn't apply
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
