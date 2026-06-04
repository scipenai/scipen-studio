import { FolderKanban, MessageSquareText, PanelLeft, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import type React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { api } from '../../api';
import { useLazyModule } from '../../hooks/useLazyModule';
import {
  TaskPriority,
  cancelIdleTask,
  getUIService,
  scheduleIdleTask,
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
import { FileExplorer } from '../FileExplorer';
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

// 加载策略说明:
// - FileExplorer:静态导入(见顶部 import)—— 文件抽屉是高频热路径轻量 UI,直接进主 chunk。
// - EditorPane / ProjectCitedReferencesPanel / 预览 / 设置:改用 useLazyModule(组件内,见下)。
//   原因:React.lazy + Suspense 在本应用「首次 resolve 不提交挂载」(诊断实测:chunk 已解析但
//   组件直到下次交互才 mount = 用户感知的「点两次才出现」)。useLazyModule 走「import→setState」
//   默认优先级,提交可靠,且保留 code-split。

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
  const previewTitle = usePreviewTitle();

  // 动态加载(替代 lazy+Suspense,提交可靠)。hook 无条件调用 = shell 挂载即后台 warm,
  // 配合下方 idle 预加载,用户开面板时已就绪。
  const EditorPane = useLazyModule(() => import('../editor/EditorPane').then((m) => m.EditorPane));
  const ProjectCitedReferencesPanel = useLazyModule(() =>
    import('../zotero/ProjectCitedReferencesPanel').then((m) => m.ProjectCitedReferencesPanel)
  );

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

  // 预加载重 chunk(idle):把 EditorPane / 预览 / cited-refs / 设置面板的代码在你首次开面板
  // 「之前」warm 进模块缓存,使首开即命中、瞬时挂载;从根上消除「首开等 chunk 下载 + 关闭即
  // 丢弃 in-flight import」这一族问题。仅 warm 代码、不挂载组件,故不引入 keep-alive 的主线程常驻代价。
  useEffect(() => {
    scheduleIdleTask(
      () => {
        // 预加载「整条 lazy 链」—— 预览是 3 层嵌套(PreviewController → PdfPreviewPane 等),
        // 只 warm 顶层会漏掉真正画 PDF 的第二层 leaf,导致首开预览仍现加载第二层 chunk。
        void import('../editor/EditorPane');
        void import('../preview/PreviewController');
        void import('../preview/PdfPreviewPane');
        void import('../preview/MarkdownPreviewPane');
        void import('../preview/TypstPreviewPane');
        void import('../preview/ZoteroPaperPane');
        void import('../zotero/ProjectCitedReferencesPanel');
        void import('../SettingsPanel');
      },
      { id: 'preload-workspace-chunks', priority: TaskPriority.Low, timeout: 3000 }
    );
    return () => {
      cancelIdleTask('preload-workspace-chunks');
    };
  }, []);

  // 焦点描边改用纯 CSS(.panel-focus-edge:focus-within,见 index.css)—— 零 React 重渲,
  // 取代原 activePanel state(每次面板点击/聚焦都重渲整 shell,且会饿死低优先级工作)。

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
            {EditorPane ? <EditorPane /> : <EditorLoadingFallback />}
          </PanelErrorBoundary>
        );
      case 'preview':
        return <PreviewPanel previewTitle={previewTitle} />;
    }
  };

  // 各面板的 Panel 级尺寸约束。背景/边框/圆角统一移到下方内层卡片 div
  // (浮动卡片布局:三面板观感一致,各自悬浮于 canvas 上)。
  const panelProps: Record<PanelId, { minSize: number; maxSize?: number; className: string }> = {
    chat: { minSize: 20, className: 'min-h-0 min-w-0' },
    editor: { minSize: 28, className: 'min-w-0' },
    preview: { minSize: 22, maxSize: 60, className: 'min-w-0' },
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
        <div className="flex h-full flex-col">
          {/* FileExplorer 静态渲染,无 Suspense gating —— 抽屉打开即出文件树 */}
          <div className="flex-1 overflow-y-auto">
            <FileExplorer />
          </div>
          {/* cited-refs 动态加载(useLazyModule),绝不阻塞上方文件树 */}
          {ProjectCitedReferencesPanel ? <ProjectCitedReferencesPanel /> : null}
        </div>
      </WorkspaceDrawer>

      {/* p-3 = 卡片与 canvas 边缘的外间隙(配合分隔条的 w-3 内间隙,四周一致 ~12px) */}
      <div className="h-full p-3">
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
              >
                {/* 浮动卡片:圆角 + 细边 + 轻阴影,悬浮于 canvas 之上 */}
                <div className="panel-focus-edge h-full overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-sm)]">
                  {renderPanelBody(panel)}
                </div>
              </Panel>
            );
            return nodes;
          })}
        </PanelGroup>
      </div>
    </WorkspaceShell>
  );
};
