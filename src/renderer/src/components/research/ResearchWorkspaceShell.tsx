import { AnimatePresence, motion } from 'framer-motion';
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
import { getChatPanelDefaultSize, WorkspaceResizeHandle } from './researchWorkspaceHelpers';
import { useResearchWorkspaceActions } from './useResearchWorkspaceActions';

const FileExplorer = lazy(() =>
  import('../FileExplorer').then((module) => ({ default: module.FileExplorer }))
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
    <div className="h-full overflow-hidden p-2" style={{ background: 'var(--color-bg-void)' }}>
      <div
        className="flex h-full flex-col overflow-hidden rounded-[20px] border shadow-[var(--shadow-lg)]"
        style={{
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-primary) 94%, transparent)',
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{
            borderBottomColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)',
          }}
        >
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-medium tracking-[-0.03em] text-[var(--color-text-primary)]">
              {headerTitle}
            </h2>
          </div>

          <div
            className="flex items-center gap-2 rounded-full border px-2 py-1 shadow-[var(--shadow-sm)]"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
            }}
          >
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
          </div>
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <AnimatePresence>
            {showFilesDrawer && (
              <>
                <motion.button
                  type="button"
                  aria-label={t('research.closeFileDrawer')}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="absolute inset-0 z-10 backdrop-blur-[1px]"
                  style={{
                    background: 'color-mix(in srgb, var(--color-backdrop) 24%, transparent)',
                  }}
                  onClick={() => {
                    uiService.setSidebarTab('im');
                  }}
                />
                <motion.div
                  initial={{ x: -24, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -24, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-y-0 left-0 z-20 w-[320px] overflow-hidden rounded-r-[24px] border-r shadow-[var(--shadow-lg)]"
                  style={{
                    borderRightColor: 'var(--color-border)',
                    background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
                  }}
                >
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
                        {t('research.loadingFiles')}
                      </div>
                    }
                  >
                    <FileExplorer />
                  </Suspense>
                </motion.div>
              </>
            )}
          </AnimatePresence>

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
                  className="min-w-0 overflow-hidden"
                  style={{ background: 'var(--color-bg-primary)' }}
                >
                  <MainLayout immersive />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>
    </div>
  );
};
