/**
 * @file useOverleafSync.ts - Overleaf sync Hook
 * @description Handles Overleaf-related sync logic, refreshes pending updates when window closes
 * @depends api, LogService, useCompilerSettings, useDOM
 */
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { useCompilerSettings } from '../services/core';
import { useWindowEvent } from './useDOM';

const logger = createLogger('OverleafSync');

/**
 * Flushes pending Overleaf updates before window unload.
 *
 * Why fire-and-forget: Browser may close before async completes. This is best-effort;
 * actual data persistence should happen during user operations.
 */
export function useOverleafFlushOnUnload() {
  const compilerSettings = useCompilerSettings();
  const projectId = compilerSettings.overleaf.projectId;

  useWindowEvent('beforeunload', () => {
    if (projectId) {
      api.overleaf.flushUpdates(projectId).catch((error) => {
        logger.error('Failed to flush Overleaf updates:', error);
      });
      logger.info('Initiated flush of pending Overleaf updates');
    }
  });
}
