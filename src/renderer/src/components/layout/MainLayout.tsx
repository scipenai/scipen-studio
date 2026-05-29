/**
 * @file MainLayout.tsx - Main Layout Container
 * @description App main layout component, manages editor, preview and log panel split display
 */

import type React from 'react';
import { Suspense, lazy } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  useIsRightPanelCollapsed,
  usePreviewVisible,
  usePreviewMode,
  useResearchLayoutFocus,
  useRightPanelTab,
} from '../../services/core/hooks';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useTranslation } from '../../locales';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { EditorLoadingFallback, PreviewLoadingFallback } from '../LoadingFallback';
import { LogPanel } from '../LogPanel';

// Lazy load editor and preview components to reduce initial bundle size
// Monaco Editor and PDF.js are large dependencies
const EditorPane = lazy(() =>
  import('../editor/EditorPane').then((module) => ({ default: module.EditorPane }))
);

const PreviewController = lazy(() =>
  import('../preview/PreviewController').then((module) => ({ default: module.PreviewController }))
);

const ZoteroPaperPane = lazy(() =>
  import('../preview/ZoteroPaperPane').then((module) => ({ default: module.ZoteroPaperPane }))
);

function usePreviewTitle(): string {
  const { t } = useTranslation();
  const previewMode = usePreviewMode();

  switch (previewMode) {
    case 'pdf':
      return t('mainLayout.pdfPreview');
    case 'markdown':
      return t('mainLayout.markdownPreview');
    case 'typst':
      return t('mainLayout.typstPreview');
    default:
      return t('mainLayout.preview');
  }
}

interface MainLayoutProps {
  immersive?: boolean;
}

const WorkspaceResizeHandle = () => (
  <PanelResizeHandle className="group relative w-2 bg-transparent transition-colors">
    <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border-subtle)] transition-colors group-hover:bg-[var(--color-accent)]" />
  </PanelResizeHandle>
);

function RightPanelContent({
  previewTitle,
  immersive = false,
}: {
  previewTitle: string;
  immersive?: boolean;
}) {
  const { t } = useTranslation();
  const rightPanelTab = useRightPanelTab();

  const setTab = (tab: 'preview' | 'paper') => getUIService().setRightPanelTab(tab);
  const tabBtn = (tab: 'preview' | 'paper', label: string) => (
    <button
      type="button"
      onClick={() => setTab(tab)}
      className="rounded-full px-4 py-2 text-sm transition-colors"
      style={
        rightPanelTab === tab
          ? {
              background: 'var(--color-accent-muted)',
              color: 'var(--color-accent)',
              border: '1px solid color-mix(in srgb, var(--color-accent) 18%, transparent)',
            }
          : { color: 'var(--color-text-muted)' }
      }
    >
      {label}
    </button>
  );

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{
        background: 'var(--color-bg-secondary)',
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-2.5"
        style={{
          borderBottomColor: immersive ? 'var(--color-border-subtle)' : 'var(--color-border)',
          background: immersive
            ? 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)'
            : 'var(--color-bg-primary)',
        }}
      >
        {tabBtn('preview', previewTitle)}
        {tabBtn('paper', t('mainLayout.paperTab'))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelErrorBoundary panelName={previewTitle}>
          <Suspense fallback={<PreviewLoadingFallback />}>
            {rightPanelTab === 'paper' ? <ZoteroPaperPane /> : <PreviewController />}
          </Suspense>
        </PanelErrorBoundary>
      </div>
    </div>
  );
}

export const MainLayout: React.FC<MainLayoutProps> = ({ immersive = false }) => {
  const { t } = useTranslation();
  const isRightPanelCollapsed = useIsRightPanelCollapsed();
  const isPreviewVisible = usePreviewVisible();
  const previewTitle = usePreviewTitle();
  const layoutFocus = useResearchLayoutFocus();
  const showRightPanel = immersive
    ? !isRightPanelCollapsed && isPreviewVisible
    : !isRightPanelCollapsed;
  const previewWidth =
    layoutFocus === 'preview'
      ? '44%'
      : layoutFocus === 'chat'
        ? '34%'
        : layoutFocus === 'files'
          ? '40%'
          : '38%';

  if (immersive) {
    return (
      <div
        className="h-full w-full overflow-hidden"
        style={{ background: 'var(--color-bg-secondary)' }}
      >
        <PanelGroup
          direction="horizontal"
          autoSaveId="research-editor-preview-layout"
          className="h-full"
        >
          <Panel
            id="research-editor-pane"
            order={1}
            defaultSize={100 - Number.parseInt(previewWidth, 10)}
            minSize={28}
            className="min-w-0 overflow-hidden"
            style={{ background: 'var(--color-bg-primary)' }}
          >
            <PanelErrorBoundary panelName={t('mainLayout.editor')}>
              <Suspense fallback={<EditorLoadingFallback />}>
                <EditorPane />
              </Suspense>
            </PanelErrorBoundary>
          </Panel>

          {showRightPanel && (
            <>
              <WorkspaceResizeHandle />
              <Panel
                id="research-preview-pane"
                order={2}
                defaultSize={Number.parseInt(previewWidth, 10)}
                minSize={22}
                maxSize={60}
                className="min-w-0 overflow-hidden border-l"
                style={{
                  borderLeftColor: 'var(--color-border-subtle)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <RightPanelContent previewTitle={previewTitle} immersive />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={60} minSize={30}>
          <PanelErrorBoundary panelName={t('mainLayout.editor')}>
            <Suspense fallback={<EditorLoadingFallback />}>
              <EditorPane />
            </Suspense>
          </PanelErrorBoundary>
        </Panel>

        {!isRightPanelCollapsed && (
          <>
            <PanelResizeHandle className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-accent)]/50 transition-colors duration-150 cursor-col-resize" />

            <Panel defaultSize={40} minSize={20}>
              <RightPanelContent previewTitle={previewTitle} />
            </Panel>
          </>
        )}
      </PanelGroup>

      <PanelErrorBoundary panelName={t('mainLayout.logPanel')}>
        <LogPanel />
      </PanelErrorBoundary>
    </div>
  );
};
