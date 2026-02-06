/**
 * @file LeftSidebar.tsx - Left Panel Container
 * @description Manages left panel view switching, supports file tree, chat, knowledge base views
 */

import type React from 'react';
import { Suspense, lazy, memo, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useSidebarTab } from '../../services/core/hooks';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { OutlinePanel } from '../OutlinePanel';

// ====== Lazy load all panel components ======
const FileExplorer = lazy(() =>
  import('../FileExplorer').then((m) => ({ default: m.FileExplorer }))
);

// ChatPanel supports Ask mode
const ChatPanel = lazy(() => import('../ChatPanel').then((m) => ({ default: m.ChatPanel })));
const KnowledgePanel = lazy(() =>
  import('../KnowledgePanel').then((m) => ({ default: m.KnowledgePanel }))
);
const SettingsPanel = lazy(() =>
  import('../SettingsPanel').then((m) => ({ default: m.SettingsPanel }))
);
const AIConfigPanel = lazy(() =>
  import('../settings/ai/AIConfigPanel').then((m) => ({ default: m.AIConfigPanel }))
);
const ToolsPanel = lazy(() => import('../ToolsPanel').then((m) => ({ default: m.ToolsPanel })));

// Preload commonly used panels (ChatPanel) to avoid loading delay on first switch
if (typeof window !== 'undefined') {
  // Preload ChatPanel when idle
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      import('../ChatPanel');
    });
  } else {
    setTimeout(() => {
      import('../ChatPanel');
    }, 1000);
  }
}

const MemoizedOutlinePanel = memo(OutlinePanel);

const LoadingFallback = () => (
  <div className="h-full flex items-center justify-center text-[var(--color-text-muted)] text-sm">
    Loading...
  </div>
);

// Title mapping
const TITLE_MAP: Record<string, string> = {
  files: 'PROJECT EXPLORER',
  knowledge: 'Knowledge Base',
  ai: 'Chat',
  tools: 'Tools',
  aiconfig: 'AI Config',
  settings: 'Settings',
};

type TabId = 'files' | 'knowledge' | 'ai' | 'tools' | 'aiconfig' | 'settings';

export const LeftSidebar: React.FC = () => {
  const sidebarTab = useSidebarTab();

  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(new Set(['files']));

  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(sidebarTab as TabId)) return prev;
      const next = new Set(prev);
      next.add(sidebarTab as TabId);
      return next;
    });
  }, [sidebarTab]);

  const title = useMemo(() => TITLE_MAP[sidebarTab] || '', [sidebarTab]);

  const isVisible = (tab: TabId) => sidebarTab === tab;
  const shouldMount = (tab: TabId) => mountedTabs.has(tab);

  const getPanelStyle = (tab: TabId): React.CSSProperties => ({
    visibility: isVisible(tab) ? 'visible' : 'hidden',
    zIndex: isVisible(tab) ? 10 : 0,
    pointerEvents: isVisible(tab) ? 'auto' : 'none',
  });

  // Only show Outline when file explorer is active
  const showOutline = sidebarTab === 'files';

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden"
      style={{
        background: 'var(--color-bg-primary)',
        borderRight: '1px solid var(--color-border-subtle)',
      }}
    >
      {/* Title bar */}
      <div
        className="h-10 px-4 flex items-center flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <h2
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {title}
        </h2>
      </div>

      {/* Main content area - Use PanelGroup to split file tree and Outline */}
      {showOutline ? (
        <PanelGroup direction="vertical" autoSaveId="sidebar-outline">
          {/* File explorer area */}
          <Panel defaultSize={70} minSize={30}>
            <div className="h-full overflow-hidden relative">
              {shouldMount('files') && (
                <div className="absolute inset-0" style={getPanelStyle('files')}>
                  <PanelErrorBoundary panelName="File Explorer">
                    <Suspense fallback={<LoadingFallback />}>
                      <FileExplorer />
                    </Suspense>
                  </PanelErrorBoundary>
                </div>
              )}
            </div>
          </Panel>

          {/* Divider */}
          <PanelResizeHandle className="h-1 bg-[var(--color-border)] hover:bg-[var(--color-accent)]/50 transition-colors cursor-row-resize group flex items-center justify-center">
            <div className="w-8 h-0.5 bg-transparent group-hover:bg-[var(--color-accent)]/70 rounded-full transition-colors" />
          </PanelResizeHandle>

          {/* Outline area */}
          <Panel defaultSize={30} minSize={15} maxSize={60}>
            <div className="h-full overflow-hidden bg-[var(--color-bg-primary)]">
              <MemoizedOutlinePanel />
            </div>
          </Panel>
        </PanelGroup>
      ) : (
        /* Other panels don't show Outline */
        <div className="flex-1 overflow-hidden relative">
          {shouldMount('files') && (
            <div className="absolute inset-0" style={getPanelStyle('files')}>
              <PanelErrorBoundary panelName="File Explorer">
                <Suspense fallback={<LoadingFallback />}>
                  <FileExplorer />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}

          {shouldMount('knowledge') && (
            <div className="absolute inset-0" style={getPanelStyle('knowledge')}>
              <PanelErrorBoundary panelName="Knowledge Base">
                <Suspense fallback={<LoadingFallback />}>
                  <KnowledgePanel />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}

          {shouldMount('ai') && (
            <div
              className="absolute inset-0 overflow-hidden"
              style={{
                ...getPanelStyle('ai'),
                // Completely isolate scroll context
                overscrollBehavior: 'none',
                contain: 'strict',
              }}
            >
              <PanelErrorBoundary panelName="Chat">
                <Suspense fallback={<LoadingFallback />}>
                  <ChatPanel />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}

          {shouldMount('tools') && (
            <div className="absolute inset-0" style={getPanelStyle('tools')}>
              <PanelErrorBoundary panelName="Tools">
                <Suspense fallback={<LoadingFallback />}>
                  <ToolsPanel />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}

          {shouldMount('aiconfig') && (
            <div className="absolute inset-0" style={getPanelStyle('aiconfig')}>
              <PanelErrorBoundary panelName="AI Config">
                <Suspense fallback={<LoadingFallback />}>
                  <AIConfigPanel />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}

          {shouldMount('settings') && (
            <div className="absolute inset-0" style={getPanelStyle('settings')}>
              <PanelErrorBoundary panelName="Settings">
                <Suspense fallback={<LoadingFallback />}>
                  <SettingsPanel />
                </Suspense>
              </PanelErrorBoundary>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
