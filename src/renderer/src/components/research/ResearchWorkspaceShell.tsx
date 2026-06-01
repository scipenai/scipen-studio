import { FolderKanban, MessageSquareText, PanelLeft, PanelRight } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import { Panel, PanelGroup, type ImperativePanelHandle } from 'react-resizable-panels';
import { api } from '../../api';
import {
  getUIService,
  useActivePanel,
  useActiveTabPath,
  useChatVisible,
  useEditorVisible,
  usePreviewVisible,
  useProjectPath,
  useSidebarTab,
} from '../../services/core';
import { openFileInEditor } from '../../services/core/FileOpenService';
import { t } from '../../locales';
import type { PanelId } from '../../services/core/UIService';
import { ChatSidebar } from '../chat';
import { IconButton } from '../ui';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { EditorLoadingFallback } from '../LoadingFallback';
import {
  WorkspaceDrawer,
  WorkspaceHeader,
  WorkspaceShell,
  WorkspaceToolbar,
} from '../layout/workspace';
import { PANEL_DEFAULT_SIZE, WorkspaceResizeHandle } from './researchWorkspaceHelpers';
import { PreviewPanel, usePreviewTitle } from './PreviewPanel';

const EditorPane = lazy(() =>
  import('../editor/EditorPane').then((module) => ({ default: module.EditorPane }))
);

const FileExplorer = lazy(() =>
  import('../FileExplorer').then((module) => ({ default: module.FileExplorer }))
);

const ProjectCitedReferencesPanel = lazy(() =>
  import('../zotero/ProjectCitedReferencesPanel').then((module) => ({
    default: module.ProjectCitedReferencesPanel,
  }))
);

/**
 * 把布尔可见性同步到 collapsible Panel 的命令式句柄。面板始终挂载(避免
 * EditorPane/ChatSidebar 反复挂载触发 OT 重连、startProject 重跑),仅靠
 * collapse()/expand() 收放。setter 判等 + 此处错位才动作,共同防环。
 */
function useSyncPanel(ref: React.RefObject<ImperativePanelHandle | null>, visible: boolean): void {
  useEffect(() => {
    const handle = ref.current;
    if (!handle) return;
    if (visible && handle.isCollapsed()) handle.expand();
    else if (!visible && handle.isExpanded()) handle.collapse();
  }, [ref, visible]);
}

export const ResearchWorkspaceShell: React.FC = () => {
  const uiService = useMemo(() => getUIService(), []);
  const projectPath = useProjectPath();
  const sidebarTab = useSidebarTab();
  const activeTabPath = useActiveTabPath();
  const chatVisible = useChatVisible();
  const editorVisible = useEditorVisible();
  const previewVisible = usePreviewVisible();
  const activePanel = useActivePanel();
  const previewTitle = usePreviewTitle();

  const showFilesDrawer = sidebarTab === 'files';

  const chatRef = useRef<ImperativePanelHandle | null>(null);
  const editorRef = useRef<ImperativePanelHandle | null>(null);
  const previewRef = useRef<ImperativePanelHandle | null>(null);

  useSyncPanel(chatRef, chatVisible);
  useSyncPanel(editorRef, editorVisible);
  useSyncPanel(previewRef, previewVisible);

  // 持久化布尔是可见性的唯一真相源。首帧内忽略 Panel 的 onCollapse/onExpand
  // 回写 —— 否则 autoSaveId 恢复的折叠态会在挂载瞬间覆盖布尔。首帧后再允许
  // 用户拖拽折叠回写。
  const writebackReadyRef = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      writebackReadyRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const onPanelVisibility = useCallback(
    (panel: PanelId, visible: boolean) => {
      if (!writebackReadyRef.current) return;
      if (panel === 'chat') uiService.setChatVisible(visible);
      else if (panel === 'editor') uiService.setEditorVisible(visible);
      else uiService.setPreviewVisible(visible);
    },
    [uiService]
  );

  const projectName = useMemo(() => {
    if (!projectPath) return null;
    return projectPath.replace(/\\/g, '/').split('/').pop() || null;
  }, [projectPath]);
  const headerTitle = projectName ?? 'SciPenClaw';

  // 进入工作台:聊天为主、编辑/预览待用户唤出。仅首挂一次。
  const hasInitializedLayoutRef = useRef(false);
  useEffect(() => {
    if (hasInitializedLayoutRef.current) return;
    hasInitializedLayoutRef.current = true;
    uiService.setSidebarTab('im');
  }, [uiService]);

  // 全局选区文本 → 预填 SNACA 输入(经 ChatSidebar 的 seed 监听)。
  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      if (data.text?.trim()) {
        uiService.requestChatWithText(data.text.trim(), 'selection');
      }
    });
    return dispose;
  }, [uiService]);

  // 切换编辑面板:打开时若有选中文件则确保其在编辑器内。
  const toggleEditor = useCallback(async () => {
    if (!editorVisible && activeTabPath) {
      await openFileInEditor(activeTabPath);
    }
    uiService.setEditorVisible(!editorVisible);
  }, [editorVisible, activeTabPath, uiService]);

  // Ctrl/Cmd + \ 折叠/展开聊天 —— 专注写作预览。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        uiService.setChatVisible(!uiService.chatVisible);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [uiService]);

  // 面板获得焦点/点击 → 标记当前任务区(驱动细描边)。
  const focusProps = (panel: PanelId) => ({
    onMouseDownCapture: () => uiService.setActivePanel(panel),
    onFocusCapture: () => uiService.setActivePanel(panel),
  });
  const edgeStyle = (panel: PanelId): React.CSSProperties =>
    activePanel === panel ? { boxShadow: 'inset 2px 0 0 var(--color-accent-dim)' } : {};

  return (
    <WorkspaceShell
      header={
        <WorkspaceHeader
          title={headerTitle}
          toolbar={
            <WorkspaceToolbar>
              <IconButton
                size="sm"
                variant="ghost"
                active={showFilesDrawer}
                tooltip={
                  showFilesDrawer ? t('research.collapseFileDrawer') : t('research.openFileDrawer')
                }
                onClick={() => uiService.setSidebarTab(showFilesDrawer ? 'im' : 'files')}
              >
                <FolderKanban size={16} />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                active={chatVisible}
                activeTone="subtle"
                tooltip={t('research.panelChat')}
                onClick={() => uiService.setChatVisible(!chatVisible)}
              >
                <MessageSquareText size={16} />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                active={editorVisible}
                activeTone="subtle"
                tooltip={t('research.panelEditor')}
                onClick={() => void toggleEditor()}
              >
                <PanelLeft size={16} />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                active={previewVisible}
                activeTone="subtle"
                tooltip={t('research.panelPreview')}
                onClick={() => uiService.setPreviewVisible(!previewVisible)}
              >
                <PanelRight size={16} />
              </IconButton>
            </WorkspaceToolbar>
          }
        />
      }
    >
      <WorkspaceDrawer
        open={showFilesDrawer}
        onClose={() => uiService.setSidebarTab('im')}
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

      <PanelGroup direction="horizontal" autoSaveId="research-workspace-v5" className="h-full">
        <Panel
          id="research-chat"
          order={1}
          ref={chatRef}
          collapsible
          collapsedSize={0}
          defaultSize={PANEL_DEFAULT_SIZE.chat}
          minSize={20}
          className="min-h-0 min-w-0"
          onCollapse={() => onPanelVisibility('chat', false)}
          onExpand={() => onPanelVisibility('chat', true)}
        >
          <div className="h-full" style={edgeStyle('chat')} {...focusProps('chat')}>
            <ChatSidebar workspaceRoot={projectPath} displayName={projectName ?? undefined} />
          </div>
        </Panel>

        <WorkspaceResizeHandle active={chatVisible && editorVisible} />

        <Panel
          id="research-editor"
          order={2}
          ref={editorRef}
          collapsible
          collapsedSize={0}
          defaultSize={PANEL_DEFAULT_SIZE.editor}
          minSize={28}
          className="min-w-0 overflow-hidden"
          style={{ background: 'var(--color-bg-primary)' }}
          onCollapse={() => onPanelVisibility('editor', false)}
          onExpand={() => onPanelVisibility('editor', true)}
        >
          <div className="h-full" style={edgeStyle('editor')} {...focusProps('editor')}>
            <PanelErrorBoundary panelName={t('mainLayout.editor')}>
              <Suspense fallback={<EditorLoadingFallback />}>
                <EditorPane />
              </Suspense>
            </PanelErrorBoundary>
          </div>
        </Panel>

        <WorkspaceResizeHandle active={editorVisible && previewVisible} />

        <Panel
          id="research-preview"
          order={3}
          ref={previewRef}
          collapsible
          collapsedSize={0}
          defaultSize={PANEL_DEFAULT_SIZE.preview}
          minSize={22}
          maxSize={60}
          className="min-w-0 overflow-hidden border-l"
          style={{
            borderLeftColor: 'var(--color-border-subtle)',
            background: 'var(--color-bg-secondary)',
          }}
          onCollapse={() => onPanelVisibility('preview', false)}
          onExpand={() => onPanelVisibility('preview', true)}
        >
          <div className="h-full" style={edgeStyle('preview')} {...focusProps('preview')}>
            <PreviewPanel previewTitle={previewTitle} />
          </div>
        </Panel>
      </PanelGroup>
    </WorkspaceShell>
  );
};
