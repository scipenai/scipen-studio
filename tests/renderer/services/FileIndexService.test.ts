/**
 * @file FileIndexService.test.ts — 项目级内容索引编排
 * @description 验证:每项目只全量索引一次(跨抽屉重挂不再重跑的前提)、切项目清旧索引、
 *   只索引 .tex/.bib/.typ、watcher 增量重索引跳过非可索引文件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const batchStatMock = vi.fn();
const batchReadMock = vi.fn();
const readMock = vi.fn();
vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    file: {
      batchStat: (paths: string[]) => batchStatMock(paths),
      batchRead: (paths: string[]) => batchReadMock(paths),
      read: (path: string) => readMock(path),
    },
  },
}));
vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const resetIndexMock = vi.fn();
const updateFileIndexMock = vi.fn();
vi.mock('../../../src/renderer/src/services/InlineCompletionService', () => ({
  getInlineCompletionService: () => ({ resetIndex: resetIndexMock }),
  updateFileIndex: (p: string, c: string) => updateFileIndexMock(p, c),
}));
// idle 任务同步执行,使断言无需等待调度器。
vi.mock('../../../src/renderer/src/services/core/IdleTaskScheduler', () => ({
  TaskPriority: { Low: 0, Normal: 1, High: 2 },
  scheduleIdleTask: (fn: () => unknown) => {
    void fn();
  },
}));

import { FileIndexService } from '../../../src/renderer/src/services/FileIndexService';
import type { FileNode } from '../../../src/renderer/src/types';

function tree(...files: string[]): FileNode {
  return {
    name: 'root',
    path: '/proj',
    type: 'directory',
    children: files.map((f) => ({
      name: f,
      path: `/proj/${f}`,
      type: 'file' as const,
    })),
  };
}

// 冲刷在途异步批次(processBatch 的 batchStat/batchRead await 立即 resolve)。
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  batchStatMock.mockResolvedValue({});
  batchReadMock.mockResolvedValue({});
  readMock.mockResolvedValue({ content: '' });
});

describe('FileIndexService', () => {
  it('每项目只全量索引一次:重复调用同项目不再扫描', async () => {
    batchStatMock.mockResolvedValue({ '/proj/a.tex': { mtime: 1 } });
    batchReadMock.mockResolvedValue({ '/proj/a.tex': '\\label{x}' });

    const svc = new FileIndexService();
    svc.indexProject('/proj', tree('a.tex'));
    await flush();

    expect(updateFileIndexMock).toHaveBeenCalledWith('/proj/a.tex', '\\label{x}');
    expect(resetIndexMock).not.toHaveBeenCalled();

    batchStatMock.mockClear();
    svc.indexProject('/proj', tree('a.tex')); // 同项目再次触发
    await flush();
    expect(batchStatMock).not.toHaveBeenCalled(); // 守卫命中,零扫描
  });

  it('切换项目清空旧索引(resetIndex)', async () => {
    const svc = new FileIndexService();
    svc.indexProject('/projA', tree('a.tex'));
    await flush();
    svc.indexProject('/projB', tree('b.tex'));
    await flush();
    expect(resetIndexMock).toHaveBeenCalledTimes(1);
  });

  it('只索引 .tex/.bib/.typ,跳过其它扩展名', async () => {
    const svc = new FileIndexService();
    svc.indexProject('/proj', tree('a.tex', 'b.bib', 'c.typ', 'd.png', 'e.md'));
    await flush();
    expect(batchStatMock.mock.calls[0][0]).toEqual(['/proj/a.tex', '/proj/b.bib', '/proj/c.typ']);
  });

  it('reindexChangedFile 跳过非可索引文件', async () => {
    const svc = new FileIndexService();
    await svc.reindexChangedFile('/proj/img.png');
    expect(readMock).not.toHaveBeenCalled();
  });

  it('reindexChangedFile 读取并更新可索引文件', async () => {
    readMock.mockResolvedValue({ content: '\\cite{a}' });
    const svc = new FileIndexService();
    await svc.reindexChangedFile('/proj/x.tex');
    expect(readMock).toHaveBeenCalledWith('/proj/x.tex');
    expect(updateFileIndexMock).toHaveBeenCalledWith('/proj/x.tex', '\\cite{a}');
  });
});
