/**
 * @file PreviewPanel.tsx - Right-column preview panel.
 * @description Single-surface preview: the compile preview (PDF/Markdown/Typst)
 *   and the Zotero paper reader share one pane. There are no visible tabs —
 *   Ctrl+Click on a \\cite hands the pane to the paper reader (which carries
 *   its own toolbar incl. a back button), and a finished compile flips back.
 *   `rightPanelTab` remains the internal routing state.
 */

import type React from 'react';
import { memo, useEffect } from 'react';
import { useRightPanelTab } from '../../services/core/hooks';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useLazyModule } from '../../hooks/useLazyModule';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { PreviewLoadingFallback } from '../LoadingFallback';

function PreviewPanelInner(): React.ReactElement {
  const rightPanelTab = useRightPanelTab();
  const PreviewController = useLazyModule(() =>
    import('../preview/PreviewController').then((m) => m.PreviewController)
  );
  const ZoteroPaperPane = useLazyModule(() =>
    import('../preview/ZoteroPaperPane').then((m) => m.ZoteroPaperPane)
  );

  // With no visible tabs, a persisted/handed-over 'paper' tab that has no
  // loaded paper is a dead end — restore the compile preview instead.
  useEffect(() => {
    if (rightPanelTab === 'paper' && !getUIService().zoteroPdf) {
      getUIService().setRightPanelTab('preview');
    }
  }, [rightPanelTab]);

  return (
    <div
      className="h-full min-h-0 overflow-hidden"
      style={{ background: 'var(--color-bg-secondary)' }}
    >
      <PanelErrorBoundary panelName="preview">
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
  );
}

/**
 * memo: when other panels toggle the shell re-renders, but this component has
 * no props — the preview subtree (PreviewController / pdf.js) skips re-rendering.
 */
export const PreviewPanel = memo(PreviewPanelInner);
