/**
 * @file CiteShotService.test.ts
 * @description 测可确定性验证的逻辑:no-pdf 短路 + 缓存、in-flight 去重、LRU 淘汰。
 *   pdf.js canvas 渲染需 DOM,不在此单测;全部用例走 no-pdf 路径(渲染前短路)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// pdf.js 运行时在此环境无法加载(worker URL),且 no-pdf 路径不会触及,stub 掉。
vi.mock('../../../src/renderer/src/services/pdf/pdfjsRuntime', () => ({
  pdfjsLib: { getDocument: vi.fn() },
  CMAP_URL: '',
}));

const mocks = vi.hoisted(() => ({
  loadPdf: vi.fn(),
  getContentList: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: { zotero: { loadPdf: mocks.loadPdf, getContentList: mocks.getContentList } },
}));

import { CiteShotService } from '../../../src/renderer/src/services/CiteShotService';

const NO_PDF = new Error('Error invoking remote method: NO_PDF_ATTACHMENT');

describe('CiteShotService', () => {
  beforeEach(() => {
    mocks.loadPdf.mockReset();
    mocks.getContentList.mockReset();
    mocks.getContentList.mockResolvedValue(null);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps NO_PDF_ATTACHMENT to {status:no-pdf} and caches it', async () => {
    mocks.loadPdf.mockRejectedValue(NO_PDF);
    const svc = new CiteShotService();

    expect(await svc.getShot('ITEM1')).toEqual({ status: 'no-pdf' });
    expect(await svc.getShot('ITEM1')).toEqual({ status: 'no-pdf' });
    // 第二次命中缓存,不再打 IPC
    expect(mocks.loadPdf).toHaveBeenCalledTimes(1);
  });

  it('returns {status:error} on non-no-pdf failures and does NOT cache (retryable)', async () => {
    mocks.loadPdf.mockRejectedValue(new Error('network down'));
    const svc = new CiteShotService();

    expect(await svc.getShot('ITEM1')).toEqual({ status: 'error' });
    expect(await svc.getShot('ITEM1')).toEqual({ status: 'error' });
    expect(mocks.loadPdf).toHaveBeenCalledTimes(2); // 未缓存 → 重试
  });

  it('deduplicates concurrent calls for the same key (single in-flight)', async () => {
    let rejectLoad: (e: unknown) => void = () => {};
    mocks.loadPdf.mockImplementation(() => new Promise((_res, rej) => (rejectLoad = rej)));
    const svc = new CiteShotService();

    const p1 = svc.getShot('ITEM1');
    const p2 = svc.getShot('ITEM1');
    expect(mocks.loadPdf).toHaveBeenCalledTimes(1); // 并发只触发一次

    rejectLoad(NO_PDF);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ status: 'no-pdf' });
    expect(r2).toEqual({ status: 'no-pdf' });
  });

  it('evicts the least-recently-used entry beyond capacity (LRU=12)', async () => {
    mocks.loadPdf.mockRejectedValue(NO_PDF);
    const svc = new CiteShotService();

    // 填 13 个不同 key → 容量 12,最早的 KEY0 被淘汰
    for (let i = 0; i < 13; i++) await svc.getShot(`KEY${i}`);
    expect(mocks.loadPdf).toHaveBeenCalledTimes(13);

    // KEY1..KEY12 仍在缓存(不再打 IPC);KEY0 已淘汰(重新打 IPC)
    await svc.getShot('KEY12');
    expect(mocks.loadPdf).toHaveBeenCalledTimes(13);
    await svc.getShot('KEY0');
    expect(mocks.loadPdf).toHaveBeenCalledTimes(14);
  });

  it('dispose clears the cache', async () => {
    mocks.loadPdf.mockRejectedValue(NO_PDF);
    const svc = new CiteShotService();

    await svc.getShot('ITEM1');
    svc.dispose();
    await svc.getShot('ITEM1');
    expect(mocks.loadPdf).toHaveBeenCalledTimes(2); // dispose 后缓存空,重新拉
  });
});
