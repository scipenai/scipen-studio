/**
 * @file FileIndexService.ts - Project file content index orchestration (data source for label/citation completion).
 * @description Scans .tex/.bib/.typ in the project and feeds content into InlineCompletionService's indexer.
 *
 *   Lifecycle = **project-scoped** (not a UI component) — survives drawer/panel remounts,
 *   so each project is fully indexed only once.
 *   This used to live in FileExplorer's useFileIndexing hook, which got reset on every
 *   drawer (AnimatePresence) remount → re-ran full stat+read on each open (idle but wasted).
 *   Moving it to a service drives indexing from the correct signals:
 *   - Initial full scan: bootstrapProject calls it once (see FileOpenService).
 *   - Incremental: file watcher content changes (see useFileWatcher.reindexChangedFile).
 *   - Live updates from open/selected file still go through editorSetup / useFileSelection.updateFileIndex.
 *
 *   mtime cache is keyed per file → repeated triggers within a project only re-read
 *   files that actually changed; switching projects clears the old index.
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
  // Monotonic; invalidates in-flight batches (stale fires return early, no queue cancel needed).
  private _runId = 0;

  /**
   * Initial full-project index (once per project). Switching projects clears old index + mtime cache.
   * Idle-batched stat+read; only reads files with changed mtime.
   */
  indexProject(projectPath: string, tree: FileNode | null): void {
    if (this._indexedProjectPath === projectPath) return;
    if (this._indexedProjectPath !== null) {
      // Switching projects: label/citation index from old project must be cleared to avoid bleed.
      getInlineCompletionService().resetIndex();
      this._indexedMtime.clear();
    }
    this._indexedProjectPath = projectPath;

    const paths = collectIndexablePaths(tree);
    if (paths.length === 0) return;
    this._scheduleBatches(paths);
  }

  /**
   * Single-file incremental re-index (driven by file watcher content changes). Skips non-indexable types.
   */
  async reindexChangedFile(filePath: string): Promise<void> {
    if (!isIndexable(filePath)) return;
    try {
      const result = await api.file.read(filePath);
      if (result?.content !== undefined) {
        updateFileIndex(filePath, result.content);
      }
    } catch (error) {
      logger.warn('incremental reindex failed', { filePath, error });
    }
  }

  private _scheduleBatches(paths: string[]): void {
    const runId = ++this._runId;

    const processBatch = async (start: number): Promise<void> => {
      if (runId !== this._runId) return; // superseded by a newer index request
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
        logger.warn('batch index failed', { error });
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
