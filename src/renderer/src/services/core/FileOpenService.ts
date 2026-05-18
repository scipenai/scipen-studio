/**
 * @file FileOpenService.ts - Shared file/project-open helpers
 * @description Opens a local file into the editor and ensures the containing project is loaded.
 *   Provides bootstrapProject() as the single entry point for project-level collaboration/scope/Overleaf setup.
 */

import { api } from '../../api';
import { createLogger } from '../LogService';
import type { FileNode } from '../../types';
import { getLanguageForFile } from '../../utils';
import { isSameOrChildPath, isSamePath } from '../../utils/pathComparison';
import {
  getEditorService,
  getProjectRuntimeContext,
  getProjectService,
  getSettingsService,
} from './ServiceRegistry';

const logger = createLogger('FileOpenService');

// ====== Project Bootstrap (single entry point) ======

export interface BootstrapProjectResult {
  projectPath: string;
  fileTree: FileNode;
  projectId: string | null;
}

export interface BootstrapProjectOptions {
  /** Fresher metadata provided after Overleaf download; overrides the version in .overleaf/project.json */
  overleafOverride?: {
    overleafProjectId: string;
    overleafDocMap: Record<string, string>;
    overleafServerUrl: string;
  };
}

/**
 * Single entry point for project-level bootstrap: project setup + Overleaf metadata restore/cleanup.
 *
 * Called by openFileInEditor / WelcomeScreen and the other open flows.
 * Do not re-implement this pipeline elsewhere.
 *
 * @param projectPath - Local project root path
 * @param fileTree - Local file tree
 * @param options - Optional overrides
 * @returns bootstrap result (final projectPath, fileTree, projectId)
 */
export async function bootstrapProject(
  projectPath: string,
  fileTree: FileNode,
  options?: BootstrapProjectOptions
): Promise<BootstrapProjectResult> {
  const projectService = getProjectService();
  const settingsService = getSettingsService();

  // ── 0. Reset runtime + load file tree ──
  getProjectRuntimeContext().update({ bootstrapState: 'booting', rootPath: projectPath });
  projectService.setProject(projectPath, fileTree);

  // ── 1. Overleaf metadata restore/cleanup ──
  // Prefer caller-provided override (e.g. freshly downloaded metadata); otherwise restore from disk
  let isOverleaf = false;
  const ovr = options?.overleafOverride;
  if (ovr) {
    isOverleaf = true;
    getProjectRuntimeContext().update({
      overleafProjectId: ovr.overleafProjectId,
      overleafDocMap: ovr.overleafDocMap,
      overleafServerUrl: ovr.overleafServerUrl,
    });
    settingsService.updateCompiler({
      overleaf: {
        ...settingsService.settings.compiler.overleaf,
        projectId: ovr.overleafProjectId,
        serverUrl: ovr.overleafServerUrl,
      },
    });
  } else {
    try {
      const meta = await api.overleaf.getProjectMeta(projectPath);
      if (meta?.overleafProjectId) {
        isOverleaf = true;
        getProjectRuntimeContext().update({
          overleafProjectId: meta.overleafProjectId,
          overleafDocMap: meta.docIdMap,
          overleafServerUrl: meta.serverUrl,
        });
        settingsService.updateCompiler({
          overleaf: {
            ...settingsService.settings.compiler.overleaf,
            projectId: meta.overleafProjectId,
            serverUrl: meta.serverUrl,
          },
        });
      }
    } catch {
      // Not an Overleaf project — nothing to restore
    }
  }

  if (!isOverleaf) {
    getProjectRuntimeContext().update({
      overleafProjectId: '',
      overleafDocMap: {},
      overleafServerUrl: '',
    });
  }

  // ── 2. Bootstrap done — mark ready ──
  getProjectRuntimeContext().update({ bootstrapState: 'ready' });

  return { projectPath, fileTree, projectId: null };
}

// ====== File Open ======

export async function openFileInEditor(filePath: string): Promise<void> {
  const projectService = getProjectService();
  const editorService = getEditorService();
  const projectPath = projectService.projectPath;
  const openTabs = editorService.tabs;

  logger.info('Opening file in editor:', filePath);

  const result = await api.file.read(filePath);
  if (result === undefined) {
    logger.error('Failed to read file:', filePath);
    return;
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  const content = result.content;
  if (result.mtime) {
    editorService.updateFileMtime(normalizedPath, result.mtime);
  }

  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  const dirPath = lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : normalizedPath;
  const targetProjectPath = dirPath;

  if (!projectPath || !isSameOrChildPath(filePath, projectPath)) {
    logger.info('Opening file within project root:', targetProjectPath);
    const openResult = await api.project.openByPath(targetProjectPath);
    if (openResult) {
      await bootstrapProject(openResult.projectPath, openResult.fileTree as FileNode);
    }
  }

  const existingTab = openTabs.find((tab) => isSamePath(tab.path, normalizedPath));
  if (existingTab) {
    editorService.setActiveTab(existingTab.path);
    return;
  }

  const fileName = normalizedPath.split('/').pop() || 'untitled';
  const language = getLanguageForFile(fileName);
  // Open with backup check — automatically restores backup contents after a crash
  await editorService.openFileWithBackupCheck(normalizedPath, content, language);
  editorService.setActiveTab(normalizedPath);
}
