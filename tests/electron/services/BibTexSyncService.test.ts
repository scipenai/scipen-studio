/**
 * @file BibTexSyncService.test.ts —— 主进程 BibTeX 同步服务单测
 * @description 覆盖:订阅事件触发同步、debounce、mtime+hash 守卫、空 ck fallback、
 *   项目切换重置守卫、setConfig 网关。fs 走注入 mock,BBT 走 mock 客户端。
 */

import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REFS_PATH = path.join('/proj', 'references.bib');
const REFS_PATH_1 = path.join('/proj1', 'references.bib');
const REFS_PATH_2 = path.join('/proj2', 'references.bib');
const BIBLIO_PATH = path.join('/proj', 'biblio.bib');

vi.mock('../../../src/main/services/LoggerService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { BibTexSyncService } from '../../../src/main/services/zotero/BibTexSyncService';
import { ZoteroEventBus } from '../../../src/main/services/zotero/ZoteroEventBus';
import type { ZoteroItemDTO } from '../../../shared/types/zotero';
import type { ZoteroEventDTO } from '../../../shared/types/zotero-events';

// ============================================================
// Fakes
// ============================================================

class FakeIndex {
  private readonly items: ZoteroItemDTO[];
  constructor(items: ZoteroItemDTO[]) {
    this.items = items;
  }
  values(): IterableIterator<ZoteroItemDTO> {
    return this.items.values();
  }
}

class FakeBBT {
  exportCalls: string[][] = [];
  exportResult = '@article{smith2024deep, ...}\n';
  exportError: Error | null = null;
  async exportBibTex(citationKeys: string[]): Promise<string> {
    this.exportCalls.push([...citationKeys]);
    if (this.exportError) throw this.exportError;
    return this.exportResult;
  }
}

function fakeBus(): ZoteroEventBus {
  // 用 noop broadcaster(不进 electron.BrowserWindow),保留 in-process emit/on。
  return new ZoteroEventBus(() => {
    /* noop */
  });
}

/** 极简 fs mock(in-memory)。 */
function inMemoryFS() {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  let clock = 1000;
  return {
    files,
    bump: (): void => {
      clock += 1000;
    },
    api: {
      async writeFile(p: string, content: string): Promise<void> {
        clock += 1000;
        files.set(p, { content, mtimeMs: clock });
      },
      async readFile(p: string): Promise<string> {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return f.content;
      },
      async stat(p: string): Promise<{ mtimeMs: number }> {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: f.mtimeMs };
      },
    } as unknown as typeof import('fs').promises,
  };
}

function item(itemKey: string, citationKey?: string): ZoteroItemDTO {
  return {
    itemKey,
    itemType: 'journalArticle',
    title: 't',
    citationKey,
  } as ZoteroItemDTO;
}

// ============================================================
// Tests
// ============================================================

describe('BibTexSyncService', () => {
  /** debounce 用了 real setTimeout(0);await 一拍 microtask 队列即可让它跑完。 */
  async function flushDebounce(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  function setup(items: ZoteroItemDTO[]) {
    const index = new FakeIndex(items);
    const bbt = new FakeBBT();
    const bus = fakeBus();
    const fs = inMemoryFS();
    const svc = new BibTexSyncService({
      index: index as unknown as Parameters<typeof BibTexSyncService.prototype.constructor>[0]['index'],
      bbt: bbt as unknown as Parameters<typeof BibTexSyncService.prototype.constructor>[0]['bbt'],
      bus,
      fileIO: fs.api,
      debounceMs: 0,
    });
    return { svc, bbt, bus, fs };
  }

  it('subscribes to bib events and writes references.bib after debounce', async () => {
    const { svc, bbt, bus, fs } = setup([
      item('A', 'smith2024'),
      item('B', 'jones2024'),
    ]);
    svc.start();
    svc.setProjectPath('/proj');

    bus.emit({
      kind: 'bib:initial',
      snapshot: { status: 'ready', etag: 'e1', items: [] },
    } as ZoteroEventDTO);
    await flushDebounce();

    expect(bbt.exportCalls).toHaveLength(1);
    expect(bbt.exportCalls[0]).toEqual(['smith2024', 'jones2024']);
    expect(fs.files.get(REFS_PATH)?.content).toBe(bbt.exportResult);
    const status = svc.getStatus();
    expect(status.kind).toBe('ok');
  });

  it('debounces multiple bib events into one write', async () => {
    const { svc, bbt, bus } = setup([item('A', 'a')]);
    svc.start();
    svc.setProjectPath('/proj');

    for (let i = 0; i < 5; i++) {
      bus.emit({
        kind: 'bib:patch',
        upserts: [],
        deletes: [],
        etag: `e${i}`,
        status: 'ready',
      } as ZoteroEventDTO);
    }
    await flushDebounce();

    expect(bbt.exportCalls).toHaveLength(1);
  });

  it('skips write when hash unchanged (debounced spam)', async () => {
    const { svc, bbt, bus, fs } = setup([item('A', 'a')]);
    svc.start();
    svc.setProjectPath('/proj');

    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();

    // 第二次同步,内容相同 → skipped
    await svc.syncNow();
    const status = svc.getStatus();
    expect(status.kind).toBe('skipped-no-change');
    expect(fs.files.size).toBe(1); // 写盘只一次
  });

  it('detects external modification (conflict guard)', async () => {
    const { svc, bbt, bus, fs } = setup([item('A', 'a')]);
    svc.start();
    svc.setProjectPath('/proj');

    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();

    // 模拟用户在外部修改了 .bib —— content + mtime 都变了
    fs.files.set(REFS_PATH, {
      content: '@article{userHand, ...}',
      mtimeMs: 999_999,
    });

    // BBT 这边内容变了(假设 mirror 新增了条目)
    bbt.exportResult = '@article{smith2024newer, ...}';
    await svc.syncNow();

    const status = svc.getStatus();
    expect(status.kind).toBe('conflict');
    expect(fs.files.get(REFS_PATH)?.content).toContain('userHand');
  });

  it('respects enabled=false gate (auto sync) but force overrides via syncNow', async () => {
    const { svc, bbt, bus } = setup([item('A', 'a')]);
    svc.setConfig({ enabled: false });
    svc.start();
    svc.setProjectPath('/proj');

    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();
    expect(bbt.exportCalls).toHaveLength(0); // 自动同步被门禁

    await svc.syncNow();
    expect(bbt.exportCalls).toHaveLength(1); // 显式手动同步穿透门禁
  });

  it('writes nothing when no item has a citationKey', async () => {
    const { svc, bbt, bus } = setup([item('A'), item('B')]);
    svc.start();
    svc.setProjectPath('/proj');

    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();

    expect(bbt.exportCalls).toHaveLength(0);
    const status = svc.getStatus();
    expect(status.kind).toBe('idle');
  });

  it('skips when projectPath is null', async () => {
    const { svc, bbt, bus } = setup([item('A', 'a')]);
    svc.start();
    // projectPath 未设
    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();
    expect(bbt.exportCalls).toHaveLength(0);
  });

  it('resets mtime/hash guards on projectPath change', async () => {
    const { svc, bbt, bus, fs } = setup([item('A', 'a')]);
    svc.start();
    svc.setProjectPath('/proj1');
    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();
    expect(fs.files.get(REFS_PATH_1)).toBeDefined();

    svc.setProjectPath('/proj2');
    await flushDebounce();

    expect(fs.files.get(REFS_PATH_2)).toBeDefined();
    // 重新写盘,因为 hash guard 已 reset(此条目相同 content 但已写两个项目)
    expect(bbt.exportCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('translator config change triggers re-export', async () => {
    const { svc, bbt, bus } = setup([item('A', 'a')]);
    svc.start();
    svc.setProjectPath('/proj');
    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();
    expect(bbt.exportCalls[0]).toEqual(['a']);

    bbt.exportResult = '@article{aDiff, ...}'; // 假装新 translator 输出不同
    svc.setConfig({ fileName: 'references.bib' }); // fileName 同名,不触发
    expect(bbt.exportCalls).toHaveLength(1);

    svc.setConfig({ fileName: 'biblio.bib' }); // fileName 变了 → 触发
    await flushDebounce();
    expect(bbt.exportCalls.length).toBeGreaterThan(1);
  });

  it('reports error when BBT export throws', async () => {
    const { svc, bbt, bus } = setup([item('A', 'a')]);
    bbt.exportError = new Error('BBT down');
    svc.start();
    svc.setProjectPath('/proj');
    bus.emit({ kind: 'bib:initial', snapshot: { status: 'ready', etag: 'e1', items: [] } });
    await flushDebounce();

    const status = svc.getStatus();
    expect(status.kind).toBe('error');
    if (status.kind === 'error') {
      expect(status.reason).toMatch(/BBT/);
    }
  });
});
