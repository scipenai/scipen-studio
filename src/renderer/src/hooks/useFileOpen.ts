/**
 * @file useFileOpen.ts - File open Hook
 * @description Handles file association open events, such as opening logic when double-clicking .tex/.typ files
 * @depends api, LogService, EditorService, ProjectService, SettingsService, useEvent
 */
import { useCallback } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { getEditorService, getProjectService, getSettingsService } from '../services/core';
import type { FileNode } from '../types';
import { getLanguageForFile } from '../utils';
import { useIpcEvent } from './useEvent';

const logger = createLogger('FileOpen');

/**
 * Handles file association open events.
 *
 * @sideeffect Opens files in editor, may change active project, updates file mtime
 */
export function useFileOpen() {
  const projectService = getProjectService();
  const editorService = getEditorService();
  const settingsService = getSettingsService();

  const projectPath = projectService.projectPath;
  const openTabs = editorService.tabs;
  const settings = settingsService.settings;

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      logger.info('Received file open event:', filePath);

      try {
        const result = await api.file.read(filePath);
        if (result === undefined) {
          logger.error('Failed to read file:', filePath);
          return;
        }
        const content = result.content;
        // Record mtime to prevent false conflict on save
        if (result.mtime) {
          editorService.updateFileMtime(filePath, result.mtime);
        }

        const dirPath = filePath.replace(/[\\/][^\\/]+$/, '');

        if (!projectPath || !filePath.startsWith(projectPath)) {
          logger.info('Opening file directory as project:', dirPath);

          const result = await api.project.openByPath(dirPath);
          if (result) {
            if (settings.compiler.engine === 'overleaf') {
              settingsService.updateCompiler({ engine: 'xelatex' });
            }
            projectService.setProject(result.projectPath, result.fileTree as FileNode);
          }
        }

        const existingTab = openTabs.find((tab) => tab.path === filePath);
        if (existingTab) {
          editorService.setActiveTab(filePath);
        } else {
          const fileName = filePath.split(/[\\/]/).pop() || 'untitled';
          editorService.addTab({
            path: filePath,
            name: fileName,
            content,
            isDirty: false,
            language: getLanguageForFile(fileName),
          });
          editorService.setActiveTab(filePath);
        }

        logger.info('File opened:', filePath);
      } catch (error) {
        logger.error('Failed to open file:', error);
      }
    },
    [
      projectPath,
      openTabs,
      editorService,
      projectService,
      settingsService,
      settings.compiler.engine,
    ]
  );

  useIpcEvent(api.win.onOpenFile, handleOpenFile);
}
