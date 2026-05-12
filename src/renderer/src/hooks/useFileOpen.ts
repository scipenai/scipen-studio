/**
 * @file useFileOpen.ts - File open Hook
 * @description Handles file association open events, such as opening logic when double-clicking .tex/.typ files
 * @depends api, LogService, EditorService, ProjectService, SettingsService, useEvent
 */
import { useCallback } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { openFileInEditor } from '../services/core/FileOpenService';
import { useIpcEvent } from './useEvent';

const logger = createLogger('FileOpen');

/**
 * Handles file association open events.
 *
 * @sideeffect Opens files in editor, may change active project, updates file mtime
 */
export function useFileOpen() {
  const handleOpenFile = useCallback(async (filePath: string) => {
    try {
      await openFileInEditor(filePath);
    } catch (error) {
      logger.error('Failed to open file:', error);
    }
  }, []);

  useIpcEvent(api.win.onOpenFile, handleOpenFile);
}
