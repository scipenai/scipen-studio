/**
 * @file useMemoryCleanup.ts - Memory cleanup Hook
 * @description Periodically cleans up inactive tab content to free memory
 * @depends LogService, EditorService
 */
import { useEffect } from 'react';
import { createLogger } from '../services/LogService';
import { getEditorService } from '../services/core';

const logger = createLogger('MemoryCleanup');

/**
 * Periodically cleans up inactive tab content to free memory.
 *
 * @param keepCount Number of inactive tabs to keep in memory
 * @param intervalMs Cleanup interval in milliseconds
 * @sideeffect Removes content from inactive editor tabs to free memory
 */
export function useMemoryCleanup(keepCount = 5, intervalMs = 5 * 60 * 1000) {
  const editorService = getEditorService();

  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      editorService.cleanupInactiveTabs(keepCount);
      logger.debug('Periodic memory cleanup complete');
    }, intervalMs);

    return () => clearInterval(cleanupInterval);
  }, [editorService, keepCount, intervalMs]);
}
