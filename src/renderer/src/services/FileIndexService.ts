/**
 * @file FileIndexService.ts - 项目文件内容索引编排(标签/引用补全的数据源)
 * @description 扫描项目内 .tex/.bib/.typ,读内容喂 InlineCompletionService 的索引器。
 *
 *   生命周期 = **项目级**(非 UI 组件)—— 跨抽屉/面板重挂存活,故每项目只全量索引一次。
 *   此前该逻辑在 FileExplorer 的 useFileIndexing hook 里,随抽屉(AnimatePresence)重挂而
 *   清零 → 每次开抽屉重跑全库 stat+read(idle 但纯浪费)。搬到服务后由正确信号驱动:
 *   - 首次全量:bootstrapProject 调一次(见 FileOpenService)。
 *   - 增量:file watcher 的内容变更(见 useFileWatcher.reindexChangedFile)。
 *   - 打开/选中文件的实时更新仍走 editorSetup / useFileSelection 的 updateFileIndex,不变。
 *
 *   mtime 缓存按文件存活 → 同项目重复触发只读「真的变了」的文件;切项目清空旧索引。
 */
import { api } from '../api';
import type { FileNode } from '../types';
import { createLogger } from './LogService';
import { getInlineCompletionService, updateFileIndex } from './InlineCompletionService';
import { TaskPriority, scheduleIdleTask } from './core/IdleTaskScheduler';

const logger = createLogger('FileIndexService');

const INDEXABLE_EXT = new Set(['bib', 'tex', 'typ']);
const BATCH_SIZE = 25;

function isIndexable(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return !!ext && INDEXABLE_EXT.has(ext);
}

function collectIndexablePaths(node: FileNode | null): string[] {
  if (!node) return [];
  const targets: string[] = [];
  const visit = (item: FileNode) => {
    if (item.type === 'file') {
      if (isIndexable(item.name)) targets.push(item.path);
      return;
    }
    item.children?.forEach(visit);
  };
  visit(node);
  return targets;
}

export class FileIndexService {
  private _indexedProjectPath: string | null = null;
  private _indexedMtime = new Map<string, number>();
  // 单调递增,作废在途批次(stale 批次 fire 时早返回,无需 cancel 队列)。
  private _runId = 0;

  /**
   * 项目首次全量索引(每项目一次)。切换项目时清空旧索引 + mtime 缓存。
   * idle 分批 stat+read,只读 mtime 变化的文件。
   */
  indexProject(projectPath: string, tree: FileNode | null): void {
    if (this._indexedProjectPath === projectPath) return;
    if (this._indexedProjectPath !== null) {
      // 切项目:旧项目的 label/citation 索引必须清掉,否则串味。
      getInlineCompletionService().resetIndex();
      this._indexedMtime.clear();
    }
    this._indexedProjectPath = projectPath;

    const paths = collectIndexablePaths(tree);
    if (paths.length === 0) return;
    this._scheduleBatches(paths);
  }

  /**
   * 单文件增量重索引(file watcher 内容变更驱动)。非可索引类型直接跳过。
   */
  async reindexChangedFile(filePath: string): Promise<void> {
    if (!isIndexable(filePath)) return;
    try {
      const result = await api.file.read(filePath);
      if (result?.content !== undefined) {
        updateFileIndex(filePath, result.content);
      }
    } catch (error) {
      logger.warn('增量重索引失败', { filePath, error });
    }
  }

  private _scheduleBatches(paths: string[]): void {
    const runId = ++this._runId;

    const processBatch = async (start: number): Promise<void> => {
      if (runId !== this._runId) return; // 被更新的索引请求取代
      const batch = paths.slice(start, start + BATCH_SIZE);
      if (batch.length === 0) return;

      try {
        const stats = await api.file.batchStat(batch);
        const toRead = batch.filter((p) => {
          const info = stats[p];
          if (!info) return false;
          const last = this._indexedMtime.get(p);
          return last === undefined || info.mtime > last;
        });

        if (toRead.length > 0) {
          const contents = await api.file.batchRead(toRead);
          for (const p of toRead) {
            const content = contents[p];
            if (content !== undefined) {
              updateFileIndex(p, content);
              const info = stats[p];
              if (info) this._indexedMtime.set(p, info.mtime);
            }
          }
        }
      } catch (error) {
        logger.warn('批量索引失败', { error });
      }

      if (start + BATCH_SIZE < paths.length) {
        scheduleIdleTask(() => void processBatch(start + BATCH_SIZE), {
          id: `file-index-batch-${runId}-${start + BATCH_SIZE}`,
          priority: TaskPriority.Low,
          timeout: 1000,
        });
      }
    };

    scheduleIdleTask(() => void processBatch(0), {
      id: `file-index-batch-${runId}-0`,
      priority: TaskPriority.Low,
      timeout: 1000,
    });
  }
}

let Instance: FileIndexService | null = null;

export function getFileIndexService(): FileIndexService {
  if (!Instance) Instance = new FileIndexService();
  return Instance;
}
