/**
 * @file PreviewController.tsx - Preview mode router
 * @description Routes to the correct preview pane based on current file type
 */

import { FileText } from 'lucide-react';
import type React from 'react';
import { Suspense, lazy } from 'react';
import { usePreviewMode } from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import { PreviewLoadingFallback } from '../LoadingFallback';

const PdfPreviewPane = lazy(() =>
  import('./PdfPreviewPane').then((module) => ({ default: module.PdfPreviewPane }))
);

const MarkdownPreviewPane = lazy(() =>
  import('./MarkdownPreviewPane').then((module) => ({ default: module.MarkdownPreviewPane }))
);

const TypstPreviewPane = lazy(() =>
  import('./TypstPreviewPane').then((module) => ({ default: module.TypstPreviewPane }))
);

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

  switch (previewMode) {
    case 'pdf':
      return (
        <Suspense fallback={<PreviewLoadingFallback />}>
          <PdfPreviewPane />
        </Suspense>
      );
    case 'markdown':
      return (
        <Suspense fallback={<PreviewLoadingFallback />}>
          <MarkdownPreviewPane />
        </Suspense>
      );
    case 'typst':
      return (
        <Suspense fallback={<PreviewLoadingFallback />}>
          <TypstPreviewPane />
        </Suspense>
      );
    default:
      return <NoPreview />;
  }
};
