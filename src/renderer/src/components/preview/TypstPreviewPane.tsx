/**
 * @file TypstPreviewPane.tsx - Typst preview state router
 * @description Shows file-scoped PDF preview for clean Typst documents and a stale-state hint after edits.
 */

import type React from 'react';
import { memo, useMemo } from 'react';
import { FileText } from 'lucide-react';
import {
  useActiveTabPath,
  useCompilationResult,
  useEditorTabs,
  useFilePdfPreview,
  useIsCompiling,
} from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import { PdfPreviewPane } from './PdfPreviewPane';

export const TypstPreviewPane: React.FC = memo(() => {
  const { t } = useTranslation();
  const activeTabPath = useActiveTabPath();
  const compilationResult = useCompilationResult();
  const tabs = useEditorTabs();
  const isCompiling = useIsCompiling();
  const pdfPreview = useFilePdfPreview(activeTabPath);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );

  if (!activeTabPath || !activeTabPath.toLowerCase().endsWith('.typ')) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <p className="text-[var(--color-text-muted)] text-sm">{t('preview.noPreview')}</p>
      </div>
    );
  }

  if (isCompiling) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <div className="text-center text-[var(--color-text-muted)]">
          <div className="w-10 h-10 border-2 border-[var(--color-accent)] border-t-transparent rounded-full mx-auto mb-4 animate-spin" />
          <p className="text-sm font-medium">{t('preview.compiling')}</p>
        </div>
      </div>
    );
  }

  // On Typst compile failure, reuse the PDF preview's error/log panel instead of falling back to the empty/no-PDF state.
  if (compilationResult && !compilationResult.success) {
    return <PdfPreviewPane />;
  }

  if (activeTab?.isDirty || pdfPreview?.isStale) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)] px-6 text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center">
          <FileText size={40} className="text-[var(--color-text-disabled)]" />
        </div>
        <p className="text-[var(--color-text-primary)] font-medium mb-2">
          {t('preview.typstPreviewStale')}
        </p>
        <p className="text-[var(--color-text-muted)] text-sm leading-relaxed max-w-md">
          {t('preview.typstCompileToRefresh')}
        </p>
      </div>
    );
  }

  if (pdfPreview?.pdfData) {
    return <PdfPreviewPane />;
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)] px-6 text-center">
      <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center">
        <FileText size={40} className="text-[var(--color-text-disabled)]" />
      </div>
      <p className="text-[var(--color-text-primary)] font-medium mb-2">
        {t('preview.noPdfAvailable')}
      </p>
      <p className="text-[var(--color-text-muted)] text-sm leading-relaxed max-w-md">
        {t('preview.typstCompileToPreview')}
      </p>
    </div>
  );
});

TypstPreviewPane.displayName = 'TypstPreviewPane';
