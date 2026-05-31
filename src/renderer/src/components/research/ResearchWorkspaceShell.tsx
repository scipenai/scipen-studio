import { FolderKanban, MessageSquareText, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { api } from '../../api';
import {
  getUIService,
  useActiveTabPath,
  usePreviewVisible,
  useProjectPath,
  useSidebarTab,
  useWorkspaceMode,
} from '../../services/core';
import { t } from '../../locales';
import { MainLayout } from '../layout/MainLayout';
import { ChatSidebar } from '../chat';
import { IconButton } from '../ui';
import {
  WorkspaceDrawer,
  WorkspaceHeader,
  WorkspaceShell,
  WorkspaceToolbar,
} from '../layout/workspace';
import { getChatPanelDefaultSize, WorkspaceResizeHandle } from './researchWorkspaceHelpers';
import { useResearchWorkspaceActions } from './useResearchWorkspaceActions';

const FileExplorer = lazy(() =>
  import('../FileExplorer').then((module) => ({ default: module.FileExplorer }))
);

const ProjectCitedReferencesPanel = lazy(() =>
  import('../zotero/ProjectCitedReferencesPanel').then((module) => ({
    default: module.ProjectCitedReferencesPanel,
  }))
);

export const ResearchWorkspaceShell: React.FC = () => {
  const uiService = useMemo(() => getUIService(), []);
  const projectPath = useProjectPath();
  const sidebarTab = useSidebarTab();
  const activeTabPath = useActiveTabPath();
  const workspaceMode = useWorkspaceMode();
  const isPreviewVisible = usePreviewVisible();
  const hasInitializedLayoutRef = useRef(false);

  const showFilesDrawer = sidebarTab === 'files';
  const showEditorPane = workspaceMode !== 'chat';
  const chatDefaultSize = getChatPanelDefaultSize(workspaceMode);
  const editorDefaultSize = 100 - chatDefaultSize;

  const projectName = useMemo(() => {
    if (!projectPath) return null;
    return projectPath.replace(/\\/g, '/').split('/').pop() || null;
  }, [projectPath]);
  const headerTitle = projectName ?? 'SciPenClaw';

  // ─── Actions hook — pure layout / artifact navigation ────────────────
  const actions = useResearchWorkspaceActions({
    uiService,
    activeTabPath,
    workspaceMode,
    isPreviewVisible,
  });

  useEffect(() => {
    if (hasInitializedLayoutRef.current) {
      return;
    }
    hasInitializedLayoutRef.current = true;
    uiService.setSidebarTab('im');
    uiService.setRightPanelCollapsed(true);
    uiService.setPreviewVisible(false);
    if (uiService.rightPanelTab !== 'preview') {
      uiService.setRightPanelTab('preview');
    }
  }, [uiService]);

  // Global text-selection capture: SelectionService forwards captured text via
  // IPC; we re-emit through uiService.requestChatWithText so ChatSidebar's
  // seed listener pre-fills the SNACA prompt input.
  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      if (data.text?.trim()) {
        uiService.requestChatWithText(data.text.trim(), 'selection');
      }
    });
    return dispose;
  }, [uiService]);

  return (
    <WorkspaceShell
      header={
        <WorkspaceHeader
          title={headerTitle}
          toolbar={
            <WorkspaceToolbar>
              <IconButton
                size="md"
                variant="ghost"
                active={showFilesDrawer}
                tooltip={
                  showFilesDrawer ? t('research.collapseFileDrawer') : t('research.openFileDrawer')
                }
                onClick={() => {
                  uiService.setSidebarTab(showFilesDrawer ? 'im' : 'files');
                }}
              >
                <FolderKanban size={16} />
              </IconButton>
              <IconButton
                size="md"
                variant="ghost"
                active={workspaceMode === 'chat'}
                tooltip={t('research.chatMainView')}
                onClick={() => {
                  uiService.setWorkspaceMode('chat');
                  uiService.setRightPanelCollapsed(true);
                  uiService.setPreviewVisible(false);
                }}
              >
                <MessageSquareText size={16} />
              </IconButton>
              <IconButton
                size="md"
                variant="ghost"
                active={workspaceMode === 'chat-editor'}
                tooltip={t('research.chatAndEdit')}
                onClick={() => {
                  void actions.toggleEditorLayout();
                }}
              >
                <PanelLeftOpen size={16} />
              </IconButton>
              <IconButton
                size="md"
                variant="ghost"
                active={workspaceMode === 'chat-editor-preview' && isPreviewVisible}
                tooltip={t('research.chatEditPreview')}
                onClick={() => {
                  void actions.togglePreviewLayout();
                }}
              >
                <PanelRightOpen size={16} />
              </IconButton>
            </WorkspaceToolbar>
          }
        />
      }
    >
      <WorkspaceDrawer
        open={showFilesDrawer}
        onClose={() => {
          uiService.setSidebarTab('im');
        }}
        closeAriaLabel={t('research.closeFileDrawer')}
      >
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
              {t('research.loadingFiles')}
            </div>
          }
        >
          <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
              <FileExplorer />
            </div>
            <ProjectCitedReferencesPanel />
          </div>
        </Suspense>
      </WorkspaceDrawer>

      <PanelGroup
        direction="horizontal"
        autoSaveId="research-workspace-layout-v4"
        className="h-full"
      >
        <Panel
          id="research-chat"
          order={1}
          defaultSize={chatDefaultSize}
          minSize={22}
          className="min-h-0 min-w-0"
        >
          <ChatSidebar workspaceRoot={projectPath} displayName={projectName ?? undefined} />
        </Panel>

        {showEditorPane && (
          <>
            <WorkspaceResizeHandle />
            <Panel
              id="research-editor"
              order={2}
              defaultSize={editorDefaultSize}
              minSize={30}
              className="min-w-0 overflow-hidden bg-[var(--color-bg-primary)]"
            >
              <MainLayout immersive />
            </Panel>
          </>
        )}
      </PanelGroup>
    </WorkspaceShell>
  );
};
