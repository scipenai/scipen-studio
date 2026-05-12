/**
 * @file useFileIndexing.ts - File indexing hook for inline completion
 * @description Schedules idle-time indexing of .bib/.tex/.typ files using batched stat+read.
 * Tracks mtime to avoid re-indexing unchanged files.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { FileNode } from '../../../types';
import { updateFileIndex } from '../../../services/InlineCompletionService';
import { TaskPriority, cancelIdleTasksByPrefix, scheduleIdleTask } from '../../../services/core';
import { api } from '../../../api';

export function useFileIndexing(projectPath: string | null, fileTree: FileNode | null) {
  // Index cache avoids re-reading files whose mtime has not changed.
  const indexedMtimeRef = useRef<Map<string, number>>(new Map());
  const lastIndexedProjectRef = useRef<string | null>(null);
  const indexRunIdRef = useRef(0);

  useEffect(() => {
    if (!projectPath) {
      lastIndexedProjectRef.current = null;
      indexedMtimeRef.current.clear();
    }
  }, [projectPath]);

  const collectIndexablePaths = useCallback((node: FileNode | null): string[] => {
    if (!node) return [];
    const targets: string[] = [];

    const visit = (item: FileNode) => {
      if (item.type === 'file') {
        const ext = item.name.split('.').pop()?.toLowerCase();
        if (ext === 'bib' || ext === 'tex' || ext === 'typ') {
          targets.push(item.path);
        }
        return;
      }
      if (item.children) {
        for (const child of item.children) {
          visit(child);
        }
      }
    };

    visit(node);
    return targets;
  }, []);

  const scheduleIndexing = useCallback(
    (tree: FileNode | null, reason: string) => {
      if (!tree || !projectPath) return;

      const indexablePaths = collectIndexablePaths(tree);
      if (indexablePaths.length === 0) return;

      // Clean up cache entries for deleted files
      const activeSet = new Set(indexablePaths);
      for (const cachedPath of indexedMtimeRef.current.keys()) {
        if (!activeSet.has(cachedPath)) {
          indexedMtimeRef.current.delete(cachedPath);
        }
      }

      cancelIdleTasksByPrefix('file-index-batch-');
      const runId = ++indexRunIdRef.current;
      const batchSize = 25;

      const processBatch = async (startIndex: number) => {
        if (runId !== indexRunIdRef.current) return;
        const batch = indexablePaths.slice(startIndex, startIndex + batchSize);
        if (batch.length === 0) return;

        try {
          const stats = await api.file.batchStat(batch);
          const toRead = batch.filter((path) => {
            const info = stats[path];
            if (!info) return false;
            const lastMtime = indexedMtimeRef.current.get(path);
            return lastMtime === undefined || info.mtime > lastMtime;
          });

          if (toRead.length > 0) {
            const contents = await api.file.batchRead(toRead);
            for (const path of toRead) {
              const content = contents[path];
              if (content !== undefined) {
                updateFileIndex(path, content);
                const info = stats[path];
                if (info) {
                  indexedMtimeRef.current.set(path, info.mtime);
                }
              }
            }
          }
        } catch (error) {
          console.warn('[FileExplorer] File index update failed:', reason, error);
        }

        if (startIndex + batchSize < indexablePaths.length) {
          // Unique ID per batch: prevents dedup logic from discarding later batches.
          scheduleIdleTask(
            () => {
              void processBatch(startIndex + batchSize);
            },
            {
              id: `file-index-batch-${runId}-${startIndex + batchSize}`,
              priority: TaskPriority.Low,
              timeout: 1000,
            }
          );
        }
      };

      scheduleIdleTask(
        () => {
          void processBatch(0);
        },
        {
          id: `file-index-batch-${runId}-0`,
          priority: TaskPriority.Low,
          timeout: 1000,
        }
      );
    },
    [collectIndexablePaths, projectPath]
  );

  // Index files on first project load (only once per project)
  useEffect(() => {
    if (!projectPath || !fileTree) return;
    if (lastIndexedProjectRef.current === projectPath) return;
    lastIndexedProjectRef.current = projectPath;
    indexedMtimeRef.current.clear();
    scheduleIndexing(fileTree, 'project-open');
  }, [projectPath, fileTree, scheduleIndexing]);

  return { scheduleIndexing };
}
