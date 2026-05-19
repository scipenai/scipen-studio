/**
 * @file useResearchWorkspaceActions.ts
 * @description Pure layout-toggle callbacks for ResearchWorkspaceShell. Chat
 *   send / artifact open paths went through the legacy builtin chat path
 *   and were removed when SNACA became the only runtime — SNACA's
 *   ChatSidebar owns its own input + thread switching.
 */

import { useCallback } from 'react';
import type { UIService } from '../../services/core/UIService';
import { openFileInEditor } from '../../services/core/FileOpenService';

export interface UseResearchWorkspaceActionsParams {
  uiService: UIService;
  activeTabPath: string | null;
  workspaceMode: 'chat' | 'chat-editor' | 'chat-editor-preview';
  isPreviewVisible: boolean;
}

export interface ResearchWorkspaceActions {
  toggleEditorLayout: () => Promise<void>;
  togglePreviewLayout: () => Promise<void>;
}

export function useResearchWorkspaceActions(
  params: UseResearchWorkspaceActionsParams
): ResearchWorkspaceActions {
  const { uiService, activeTabPath, workspaceMode, isPreviewVisible } = params;

  const toggleEditorLayout = useCallback(async () => {
    if (workspaceMode === 'chat-editor') {
      uiService.setWorkspaceMode('chat');
      uiService.setRightPanelCollapsed(true);
      uiService.setPreviewVisible(false);
      return;
    }
    if (activeTabPath) {
      // Already-open tab: nothing to open. Otherwise the path may have been
      // staged by another flow; openFileInEditor is idempotent on existing tabs.
      await openFileInEditor(activeTabPath);
    }
    uiService.setSidebarTab('im');
    uiService.setWorkspaceMode('chat-editor');
    uiService.setRightPanelCollapsed(true);
    uiService.setPreviewVisible(false);
  }, [activeTabPath, uiService, workspaceMode]);

  const togglePreviewLayout = useCallback(async () => {
    if (workspaceMode === 'chat-editor-preview' && isPreviewVisible) {
      uiService.setWorkspaceMode('chat');
      uiService.setRightPanelCollapsed(true);
      uiService.setPreviewVisible(false);
      return;
    }
    if (activeTabPath) {
      await openFileInEditor(activeTabPath);
    }
    uiService.setSidebarTab('im');
    uiService.setWorkspaceMode('chat-editor-preview');
    uiService.setRightPanelTab('preview');
    uiService.setRightPanelCollapsed(false);
    uiService.setPreviewVisible(true);
  }, [activeTabPath, isPreviewVisible, uiService, workspaceMode]);

  return {
    toggleEditorLayout,
    togglePreviewLayout,
  };
}
