import { FolderKanban, MessageSquareText, PanelLeft, PanelRight } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo } from 'react';
import type React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
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

/** 面板在 PanelGroup 中的固定顺序(react-resizable-panels 靠 order 跨增删保持次序)。 */
const PANEL_ORDER: Record<PanelId, number> = { chat: 1, editor: 2, preview: 3 };

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

  const projectName = useMemo(() => {
    if (!projectPath) return null;
    return projectPath.replace(/\\/g, '/').split('/').pop() || null;
  }, [projectPath]);
  const headerTitle = projectName ?? 'SciPenClaw';

  // 进入工作台:默认聚焦 IM 侧栏(关掉文件抽屉)。shell 仅挂载一次,
  // setSidebarTab 幂等,无需额外一次性守卫。
  useEffect(() => {
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

  // 唯一真相源:布尔 → 可见面板列表。布局完全由此声明式推导,
  // 只挂可见面板 + 可见面板之间的分隔条 —— 无 ref / 无命令式折叠 / 无回写竞态。
  const visiblePanels = (
    [chatVisible && 'chat', editorVisible && 'editor', previewVisible && 'preview'] as const
  ).filter((p): p is PanelId => Boolean(p));

  const renderPanelBody = (panel: PanelId): React.ReactNode => {
    switch (panel) {
      case 'chat':
        return <ChatSidebar workspaceRoot={projectPath} displayName={projectName ?? undefined} />;
      case 'editor':
        return (
          <PanelErrorBoundary panelName={t('mainLayout.editor')}>
            <Suspense fallback={<EditorLoadingFallback />}>
              <EditorPane />
            </Suspense>
          </PanelErrorBoundary>
        );
      case 'preview':
        return <PreviewPanel previewTitle={previewTitle} />;
    }
  };

  // 各面板的 Panel 级属性(背景/边框/尺寸约束)。
  const panelProps: Record<PanelId, { minSize: number; maxSize?: number; style?: React.CSSProperties; className: string }> = {
    chat: { minSize: 20, className: 'min-h-0 min-w-0' },
    editor: {
      minSize: 28,
      className: 'min-w-0 overflow-hidden',
      style: { background: 'var(--color-bg-primary)' },
    },
    preview: {
      minSize: 22,
      maxSize: 60,
      className: 'min-w-0 overflow-hidden border-l',
      style: { borderLeftColor: 'var(--color-border-subtle)', background: 'var(--color-bg-secondary)' },
    },
  };

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

      <PanelGroup direction="horizontal" autoSaveId="research-workspace-v6" className="h-full">
        {visiblePanels.flatMap((panel, index) => {
          const cfg = panelProps[panel];
          const nodes: React.ReactNode[] = [];
          // 分隔条只出现在两个可见面板之间(声明式 → 与面板增删天然一致)。
          if (index > 0) nodes.push(<WorkspaceResizeHandle key={`handle-${panel}`} />);
          nodes.push(
            // key 用面板身份 → 切换其它面板时本面板实例原地保留,不重挂载。
            <Panel
              key={panel}
              id={`research-${panel}`}
              order={PANEL_ORDER[panel]}
              defaultSize={PANEL_DEFAULT_SIZE[panel]}
              minSize={cfg.minSize}
              maxSize={cfg.maxSize}
              className={cfg.className}
              style={cfg.style}
            >
              <div className="h-full" style={edgeStyle(panel)} {...focusProps(panel)}>
                {renderPanelBody(panel)}
              </div>
            </Panel>
          );
          return nodes;
        })}
      </PanelGroup>
    </WorkspaceShell>
  );
};
