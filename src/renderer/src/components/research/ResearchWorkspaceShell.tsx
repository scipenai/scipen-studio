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

// Loading strategy notes:
// - FileExplorer: static import (see top of file) — file drawer is a hot-path lightweight UI, ships in main chunk.
// - EditorPane / ProjectCitedReferencesPanel / preview / settings: use useLazyModule (in-component, see below).
//   Reason: React.lazy + Suspense in this app "fails to commit on first resolve" (diagnosed: chunk resolves but
//   the component does not mount until next interaction = user-perceived "have to click twice"). useLazyModule
//   uses "import -> setState" at default priority, commits reliably, and preserves code-split.

/** Fixed order of panels in PanelGroup (react-resizable-panels relies on `order` to keep ordering across add/remove). */
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

  // Dynamic loading (replaces lazy+Suspense, commits reliably). Hook is called unconditionally =
  // shell mount kicks off background warm; combined with the idle preload below, the module is
  // ready by the time the user opens the panel.
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
  const headerSubtitle = useMemo(() => {
    const panels = [
      chatVisible && t('research.panelChat'),
      editorVisible && t('research.panelEditor'),
      previewVisible && t('research.panelPreview'),
    ].filter((label): label is string => Boolean(label));
    return panels.join(' / ');
  }, [chatVisible, editorVisible, previewVisible]);

  // On entering the workspace: focus the IM sidebar by default (close the file drawer).
  // shell only mounts once and setSidebarTab is idempotent, so no extra one-shot guard is needed.
  useEffect(() => {
    uiService.setSidebarTab('im');
  }, [uiService]);

  // Global selected text -> prefill SNACA input (via ChatSidebar's seed listener).
  useEffect(() => {
    const dispose = api.selection.onTextCaptured((data) => {
      if (data.text?.trim()) {
        uiService.requestChatWithText(data.text.trim(), 'selection');
      }
    });
    return dispose;
  }, [uiService]);

  // Toggle the editor panel: when opening, ensure the currently selected file is loaded into the editor.
  const toggleEditor = useCallback(async () => {
    if (!editorVisible && activeTabPath) {
      await openFileInEditor(activeTabPath);
    }
    uiService.setEditorVisible(!editorVisible);
  }, [editorVisible, activeTabPath, uiService]);

  // Ctrl/Cmd + \ collapses/expands chat — focus mode for writing/preview.
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

  // Preload heavy chunks at idle: warm EditorPane / preview / cited-refs / settings panel code into
  // the module cache *before* the user first opens those panels, so first-open hits cache and mounts
  // instantly. This eliminates the whole class of "first-open waits for chunk download + closing
  // discards the in-flight import" bugs. We only warm code, not mount components, so this avoids
  // the main-thread cost of a keep-alive approach.
  useEffect(() => {
    scheduleIdleTask(
      () => {
        // Preload the entire lazy chain — preview is 3 levels nested (PreviewController -> PdfPreviewPane etc.).
        // Warming only the top level would miss the second-level leaf that actually renders the PDF, so the
        // first preview open would still hit a chunk download for the second level.
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

  // Focus outline uses pure CSS (.panel-focus-edge:focus-within, see index.css) — zero React re-renders,
  // replacing the old activePanel state (which re-rendered the whole shell on every panel click/focus and
  // starved low-priority work).

  // Single source of truth: booleans -> visible-panel list. The layout is derived declaratively from this,
  // mounting only visible panels plus the resize handles between them — no refs, no imperative collapse,
  // no write-back race conditions.
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

  // Panel-level size constraints for each panel. Background/border/radius all live on the inner card
  // div below (floating-card layout: the three panels feel consistent, each floating above the canvas).
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
          subtitle={headerSubtitle}
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
          {/* FileExplorer renders statically with no Suspense gating — file tree shows as soon as the drawer opens. */}
          <div className="flex-1 overflow-y-auto">
            <FileExplorer />
          </div>
          {/* cited-refs is dynamically loaded (useLazyModule) and must never block the file tree above. */}
          {ProjectCitedReferencesPanel ? <ProjectCitedReferencesPanel /> : null}
        </div>
      </WorkspaceDrawer>

      {/* p-3 = outer gap between cards and the canvas edge (matches the w-3 inner gap on resize handles, ~12px on all sides). */}
      <div className="h-full p-3">
        <PanelGroup direction="horizontal" autoSaveId="research-workspace-v6" className="h-full">
          {visiblePanels.flatMap((panel, index) => {
            const cfg = panelProps[panel];
            const nodes: React.ReactNode[] = [];
            // Resize handle only appears between two visible panels (declarative -> stays consistent as panels are added/removed).
            if (index > 0) nodes.push(<WorkspaceResizeHandle key={`handle-${panel}`} />);
            nodes.push(
              // Key is the panel identity -> when other panels toggle, this panel's instance stays in place and is not remounted.
              <Panel
                key={panel}
                id={`research-${panel}`}
                order={PANEL_ORDER[panel]}
                defaultSize={PANEL_DEFAULT_SIZE[panel]}
                minSize={cfg.minSize}
                maxSize={cfg.maxSize}
                className={cfg.className}
              >
                {/* Floating card: rounded + thin border + light shadow, floats above the canvas. */}
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
