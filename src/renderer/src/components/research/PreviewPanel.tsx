/**
 * @file PreviewPanel.tsx - Right-column preview panel (preview / paper dual tab).
 * @description Extracted from the original MainLayout's RightPanelContent with the logic unchanged.
 *   After the main page was flattened to a single layer of three panels, preview is now rendered
 *   directly by this component as a standalone Panel. The preview/paper tab switching and the
 *   ZoteroPaperPane (paper tab) behavior match the original implementation.
 */

import type React from 'react';
import { memo } from 'react';
import { useRightPanelTab, usePreviewMode } from '../../services/core/hooks';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useTranslation } from '../../locales';
import { useLazyModule } from '../../hooks/useLazyModule';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { PreviewLoadingFallback } from '../LoadingFallback';

/** Preview title follows previewMode (pdf / markdown / typst). */
export function usePreviewTitle(): string {
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

function PreviewPanelInner({ previewTitle }: { previewTitle: string }): React.ReactElement {
  const { t } = useTranslation();
  const rightPanelTab = useRightPanelTab();
  const PreviewController = useLazyModule(() =>
    import('../preview/PreviewController').then((m) => m.PreviewController)
  );
  const ZoteroPaperPane = useLazyModule(() =>
    import('../preview/ZoteroPaperPane').then((m) => m.ZoteroPaperPane)
  );

  const setTab = (tab: 'preview' | 'paper') => getUIService().setRightPanelTab(tab);
  // iOS-style segmented control: a recessed track (bg-void) with a raised white active pill
  // (bg-primary + light shadow); inactive tabs are transparent muted. Replaces the old 2px
  // underline / accent outline.
  const tabBtn = (tab: 'preview' | 'paper', label: string) => {
    const active = rightPanelTab === tab;
    return (
      <button
        type="button"
        onClick={() => setTab(tab)}
        className="rounded-md px-3 py-1 text-[13px] font-medium transition-colors"
        style={{
          background: active ? 'var(--color-bg-primary)' : 'transparent',
          color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
          boxShadow: active ? 'var(--shadow-xs)' : 'none',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--color-bg-secondary)' }}
    >
      <div
        className="flex items-center border-b px-4 py-2"
        style={{ borderBottomColor: 'var(--color-border-subtle)' }}
      >
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-[var(--color-bg-void)] p-0.5">
          {tabBtn('preview', previewTitle)}
          {tabBtn('paper', t('mainLayout.paperTab'))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelErrorBoundary panelName={previewTitle}>
          {rightPanelTab === 'paper' ? (
            ZoteroPaperPane ? (
              <ZoteroPaperPane />
            ) : (
              <PreviewLoadingFallback />
            )
          ) : PreviewController ? (
            <PreviewController />
          ) : (
            <PreviewLoadingFallback />
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}

/**
 * memo: when other panels toggle the shell re-renders, but previewTitle is stable -> the preview
 * subtree (PreviewController / pdf.js) skips re-rendering.
 */
export const PreviewPanel = memo(PreviewPanelInner);
