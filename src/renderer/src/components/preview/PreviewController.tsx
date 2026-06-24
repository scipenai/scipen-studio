/**
 * @file PreviewController.tsx - Preview mode router
 * @description Routes to the correct preview pane based on current file type
 */

import { FileText } from 'lucide-react';
import type React from 'react';
import { usePreviewMode } from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import { useLazyModule } from '../../hooks/useLazyModule';
import { PreviewLoadingFallback } from '../LoadingFallback';

const NoPreview: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center">
          <FileText size={40} className="text-[var(--color-text-disabled)]" />
        </div>
        <p className="text-[var(--color-text-secondary)] font-medium">{t('preview.noPreview')}</p>
      </div>
    </div>
  );
};

export const PreviewController: React.FC = () => {
  const previewMode = usePreviewMode();
  // All three leaves are dynamically loaded via useLazyModule (a replacement for lazy+Suspense) so commits are reliable;
  // the rules of hooks require unconditional calls, so we warm all three and render the selected one by previewMode.
  const PdfPreviewPane = useLazyModule(() =>
    import('./PdfPreviewPane').then((m) => m.PdfPreviewPane)
  );
  const MarkdownPreviewPane = useLazyModule(() =>
    import('./MarkdownPreviewPane').then((m) => m.MarkdownPreviewPane)
  );
  const TypstPreviewPane = useLazyModule(() =>
    import('./TypstPreviewPane').then((m) => m.TypstPreviewPane)
  );

  switch (previewMode) {
    case 'pdf':
      return PdfPreviewPane ? <PdfPreviewPane /> : <PreviewLoadingFallback />;
    case 'markdown':
      return MarkdownPreviewPane ? <MarkdownPreviewPane /> : <PreviewLoadingFallback />;
    case 'typst':
      return TypstPreviewPane ? <TypstPreviewPane /> : <PreviewLoadingFallback />;
    default:
      return <NoPreview />;
  }
};
