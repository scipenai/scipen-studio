/**
 * @file ZoteroBibMirror.test.ts — renderer 侧 canonical 镜像单元测试
 * @description 用 vi.mock 隔离 `api.zotero.*`,聚焦 mirror 的事件 → state 转换语义。
 *              覆盖:start/stop 生命周期、初始 snapshot(reset/patch 分支)、
 *              bib:initial/patch/status/invalidated 处理、查询 API、订阅通知。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZoteroItemDTO } from '../../../shared/types/zotero';
import type {
  BibPatchDTO,
  BibResetDTO,
  ZoteroDiagnosticsDTO,
  ZoteroEventDTO,
} from '../../../shared/types/zotero-events';

// Mock IPC surface ——必须在 ZoteroBibMirror 导入前注册。
type EventCallback = (event: ZoteroEventDTO) => void;
const mockState: {
  snapshotResult: BibResetDTO | BibPatchDTO;
  diagnostics: ZoteroDiagnosticsDTO;
  eventCallbacks: Set<EventCallback>;
  refreshCount: number;
} = {
  snapshotResult: emptyReset(),
  diagnostics: emptyDiagnostics(),
  eventCallbacks: new Set(),
  refreshCount: 0,
};

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getSnapshot: vi.fn(async () => mockState.snapshotResult),
      getDiagnostics: vi.fn(async () => mockState.diagnostics),
      requestRefresh: vi.fn(async () => {
        mockState.refreshCount += 1;
        return { triggered: true, status: 'syncing' as const };
      }),
      onEvent: (cb: EventCallback) => {
        mockState.eventCallbacks.add(cb);
        return () => mockState.eventCallbacks.delete(cb);
      },
      getSettings: vi.fn(),
      onSettingsChanged: vi.fn(() => () => {}),
    },
  },
}));

import {
  __resetZoteroBibMirrorSingleton,
  getZoteroBibMirror,
} from '../../../src/renderer/src/services/zotero/ZoteroBibMirror';

function emptyReset(): BibResetDTO {
  return { status: 'ready', etag: 'etag-0', reset: true, items: [] };
}

function emptyDiagnostics(): ZoteroDiagnosticsDTO {
  return {
    status: 'idle',
    sources: { localApi: { ok: false }, betterBibTex: { ok: false } },
    itemCount: 0,
    etag: '',
  };
}

function item(itemKey: string, citationKey?: string, title?: string): ZoteroItemDTO {
  return {
    itemKey,
    itemType: 'journalArticle',
    title: title ?? `Item ${itemKey}`,
    creatorsLabel: 'Smith',
    year: 2024,
    citationKey,
    citation: '',
    bib: '',
  };
}

function emit(event: ZoteroEventDTO): void {
  for (const cb of mockState.eventCallbacks) cb(event);
}

beforeEach(() => {
  mockState.snapshotResult = emptyReset();
  mockState.diagnostics = emptyDiagnostics();
  mockState.eventCallbacks.clear();
  mockState.refreshCount = 0;
});

afterEach(() => {
  __resetZoteroBibMirrorSingleton();
});

describe('ZoteroBibMirror — start + initial snapshot', () => {
  it('hydrates from BibResetDTO and exposes items by both keys', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1', 'smith2024'), item('A2')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    expect(mirror.getState().status).toBe('ready');
    expect(mirror.getState().etag).toBe('etag-1');
    expect(mirror.getState().itemCount).toBe(2);
    expect(mirror.getState().ready).toBe(true);
    expect(mirror.getByItemKey('A1')?.itemKey).toBe('A1');
    expect(mirror.getByCitationKey('smith2024')?.itemKey).toBe('A1');
  });

  it('applies BibPatchDTO when getSnapshot returns a delta', async () => {
    mockState.snapshotResult = {
      status: 'degraded',
      etag: 'etag-1',
      reset: false,
      upserts: [item('B1', 'jones2024')],
      deletes: [],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    expect(mirror.getState().itemCount).toBe(1);
    expect(mirror.getState().status).toBe('degraded');
    expect(mirror.getByCitationKey('jones2024')?.itemKey).toBe('B1');
  });
});

describe('ZoteroBibMirror — incremental events', () => {
  it('bib:patch upserts new items and bumps etag', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1', 'smith2024')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    emit({
      kind: 'bib:patch',
      status: 'ready',
      etag: 'etag-2',
      upserts: [item('A2', 'doe2024', 'New Paper')],
      deletes: [],
    });

    expect(mirror.getState().etag).toBe('etag-2');
    expect(mirror.getState().itemCount).toBe(2);
    expect(mirror.getByCitationKey('doe2024')?.title).toBe('New Paper');
  });

  it('bib:patch with same etag as current is a no-op (race protection)', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    const before = mirror.getState();
    emit({
      kind: 'bib:patch',
      status: 'ready',
      etag: 'etag-1', // 与当前 etag 相同 → 已 apply,跳过
      upserts: [item('A2')],
      deletes: [],
    });
    expect(mirror.getState()).toBe(before);
    expect(mirror.getState().itemCount).toBe(1);
  });

  it('bib:patch deletes drop items + citationKey reverse mapping', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1', 'smith2024')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    emit({
      kind: 'bib:patch',
      status: 'ready',
      etag: 'etag-2',
      upserts: [],
      deletes: ['A1'],
    });

    expect(mirror.getByItemKey('A1')).toBeUndefined();
    expect(mirror.getByCitationKey('smith2024')).toBeUndefined();
    expect(mirror.getState().itemCount).toBe(0);
  });

  it('bib:initial fully replaces the current index', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1', 'smith2024')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    emit({
      kind: 'bib:initial',
      snapshot: {
        status: 'ready',
        etag: 'etag-2',
        items: [item('B1', 'jones2024')],
      },
    });

    expect(mirror.getByItemKey('A1')).toBeUndefined();
    expect(mirror.getByCitationKey('jones2024')?.itemKey).toBe('B1');
    expect(mirror.getState().etag).toBe('etag-2');
  });

  it('bib:status updates only the status field', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    emit({ kind: 'bib:status', status: 'syncing' });
    expect(mirror.getState().status).toBe('syncing');
    expect(mirror.getState().etag).toBe('etag-1'); // 未变
    expect(mirror.getState().itemCount).toBe(1);
  });

  it('bib:invalidated is a pure information event (no state change)', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1')],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    const before = mirror.getState();
    emit({ kind: 'bib:invalidated', reason: 'focus' });
    expect(mirror.getState()).toBe(before);
  });
});

describe('ZoteroBibMirror — subscribe + search', () => {
  it('notifies subscribers on every state change', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1')],
    };
    const mirror = getZoteroBibMirror();
    const listener = vi.fn();
    mirror.subscribe(listener);
    await mirror.start();

    const beforeCount = listener.mock.calls.length;
    emit({ kind: 'bib:status', status: 'syncing' });
    expect(listener.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it('searchByQuery returns trigram-ranked candidates', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [
        item('A1', 'smith2024deep', 'Deep Learning Survey'),
        item('A2', 'jones2024', 'Unrelated Math Paper'),
      ],
    };
    const mirror = getZoteroBibMirror();
    await mirror.start();

    const hits = mirror.searchByQuery('smit');
    expect(hits[0]?.itemKey).toBe('A1');
  });
});

describe('ZoteroBibMirror — lifecycle', () => {
  it('stop clears data + state, listeners stay alive for restart', async () => {
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-1',
      reset: true,
      items: [item('A1')],
    };
    const mirror = getZoteroBibMirror();
    const listener = vi.fn();
    mirror.subscribe(listener);
    await mirror.start();

    mirror.stop();
    expect(mirror.getState().status).toBe('idle');
    expect(mirror.getState().itemCount).toBe(0);
    expect(mirror.getState().ready).toBe(false);
    // listener 仍被通知到了 stop 引起的状态变更
    expect(listener).toHaveBeenCalled();

    // 重新 start 应该重新拉一次 snapshot
    mockState.snapshotResult = {
      status: 'ready',
      etag: 'etag-2',
      reset: true,
      items: [item('B1', 'jones')],
    };
    await mirror.start();
    expect(mirror.getState().etag).toBe('etag-2');
    expect(mirror.getByCitationKey('jones')?.itemKey).toBe('B1');
  });

  it('refresh delegates to api.zotero.requestRefresh', async () => {
    const mirror = getZoteroBibMirror();
    await mirror.refresh();
    expect(mockState.refreshCount).toBe(1);
  });
});
