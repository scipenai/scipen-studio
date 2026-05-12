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
  getConversationScopeService,
  getEditorService,
  getProjectRuntimeContext,
  getProjectService,
  getSettingsService,
} from './ServiceRegistry';
import {
  ensureCollaboration,
  activateProjectConversationScope,
  clearActiveCollaborationProjectState,
} from './CollaborationBootstrapService';

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
 * Single entry point for project-level bootstrap: collaboration → scope activation →
 * Overleaf metadata restore/cleanup.
 *
 * Called by openFileInEditor / WelcomeScreen and the other open flows.
 * Do not re-implement this pipeline elsewhere.
 *
 * @param projectPath - Local project root path
 * @param fileTree - Local file tree (uploaded when creating the remote project for the first time)
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

  // ── 0. Clear prior state and enter booting ──
  clearActiveCollaborationProjectState();
  getConversationScopeService().clearActiveBinding();
  // Restore baseline rootPath immediately after reset — IM-only mode relies on it for context
  getProjectRuntimeContext().update({ bootstrapState: 'booting', rootPath: projectPath });
  projectService.setProject(projectPath, fileTree);

  // ── 1. Collaboration bootstrap (OT connection + binding resolve/create) ──
  let collabResult: Awaited<ReturnType<typeof ensureCollaboration>>;
  try {
    collabResult = await ensureCollaboration(projectPath, fileTree);
  } catch (error) {
    logger.error('ensureCollaboration failed:', error);
    getProjectRuntimeContext().update({ bootstrapState: 'failed' });
    throw error;
  }
  if (collabResult) {
    projectService.setProject(collabResult.projectPath, collabResult.fileTree);
  }

  const finalProjectPath = collabResult?.projectPath ?? projectPath;
  const finalFileTree = collabResult?.fileTree ?? fileTree;
  const projectId = collabResult?.projectId ?? null;

  // Collaboration may have changed projectPath (Overleaf download, etc.) — sync rootPath
  getProjectRuntimeContext().update({ rootPath: finalProjectPath });

  // ── 2. Scope activation ──
  await activateProjectConversationScope(finalProjectPath, projectId);

  // ── 3. Overleaf metadata restore/cleanup ──
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
      const meta = await api.overleaf.getProjectMeta(finalProjectPath);
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

  // ── 4. Bootstrap done — mark ready ──
  getProjectRuntimeContext().update({ bootstrapState: 'ready' });

  return { projectPath: finalProjectPath, fileTree: finalFileTree, projectId };
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
  let targetProjectPath = dirPath;

  // Query only (getByPath): do not trigger resolveBinding's collaboration side effects.
  // bootstrapProject() below handles collaboration activation uniformly.
  try {
    const binding = await api.projectBinding.getByPath(dirPath);
    if (binding?.localRootPath) {
      targetProjectPath = binding.localRootPath;
    }
  } catch (error) {
    logger.warn('Failed to find binding for file path, fallback to parent directory:', error);
  }

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
