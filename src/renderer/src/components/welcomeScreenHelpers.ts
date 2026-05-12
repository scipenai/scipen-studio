/**
 * @file welcomeScreenHelpers.ts - Pure business-logic helpers for WelcomeScreen
 * @description Utility functions, types and constants extracted from WelcomeScreen.tsx;
 * does not depend on React hooks.
 */

import { api } from '../api';
import { isSameOrChildPath } from '../utils/pathComparison';
import { getEditorService, getUIService } from '../services/core';
import { bootstrapProject } from '../services/core/FileOpenService';
import type { FileNode } from '../types';

export interface RecentProjectSummary {
  path: string;
  name: string;
  lastOpened: number;
}

export const WELCOME_FONT_FAMILY =
  "'Aptos', 'SF Pro Display', 'PingFang SC', 'Microsoft YaHei UI', 'Segoe UI Variable', sans-serif";

/** Find the _id by path in an OT file tree. */
export function findFileNodeId(node: FileNode, targetPath: string): string | undefined {
  const normalized = targetPath.replace(/\\/g, '/');
  if (node.type === 'file' && node.path.replace(/\\/g, '/') === normalized) {
    return node._id;
  }
  for (const child of node.children || []) {
    const found = findFileNodeId(child, targetPath);
    if (found) return found;
  }
  return undefined;
}

export function resetWorkspaceToChat(): void {
  const uiService = getUIService();
  uiService.setSidebarTab('im');
  uiService.setResearchLayoutFocus('chat');
  uiService.setWorkspaceMode('chat');
  uiService.setRightPanelCollapsed(true);
  uiService.setPreviewVisible(false);
  uiService.setActiveArtifactPath(null);
  uiService.setActiveArtifactId(null);
}

export function cleanupStaleTabs(projectPath: string): void {
  const editorSvc = getEditorService();
  for (const tab of editorSvc.tabs) {
    if (isSameOrChildPath(tab.path, projectPath)) {
      void api.file.exists(tab.path).then((exists) => {
        if (!exists) editorSvc.closeTab(tab.path);
      });
    }
  }
}

export async function bootstrapExistingProject(
  projectPath: string,
  fileTree: FileNode
): Promise<void> {
  const bootstrapped = await bootstrapProject(projectPath, fileTree);

  cleanupStaleTabs(bootstrapped.projectPath);
  resetWorkspaceToChat();
}
