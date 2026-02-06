/**
 * @file MainLayout.tsx - Main Layout Container
 * @description App main layout component, manages editor, preview and log panel split display
 */

import type React from 'react';
import { Suspense, lazy } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useIsRightPanelCollapsed } from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { EditorLoadingFallback, PreviewLoadingFallback } from '../LoadingFallback';
import { LogPanel } from '../LogPanel';

// Lazy load editor and preview components to reduce initial bundle size
// Monaco Editor and PDF.js are large dependencies
const EditorPane = lazy(() =>
  import('../editor/EditorPane').then((module) => ({ default: module.EditorPane }))
);

const PreviewPane = lazy(() =>
  import('../preview/PreviewPane').then((module) => ({ default: module.PreviewPane }))
);

export const MainLayout: React.FC = () => {
  const { t } = useTranslation();
  const isRightPanelCollapsed = useIsRightPanelCollapsed();

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
              <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
                <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
                  <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-[var(--color-text-primary)] border-b-2 border-[var(--color-accent)] bg-[var(--color-bg-hover)]">
                    {t('mainLayout.pdfPreview')}
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <PanelErrorBoundary panelName={t('mainLayout.pdfPreview')}>
                    <Suspense fallback={<PreviewLoadingFallback />}>
                      <PreviewPane />
                    </Suspense>
                  </PanelErrorBoundary>
                </div>
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>

      <PanelErrorBoundary panelName="日志面板">
        <LogPanel />
      </PanelErrorBoundary>
    </div>
  );
};
