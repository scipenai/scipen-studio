/**
 * @file ZoteroPaperPane —— 右栏「论文」tab 的内容。薄包装:有 Zotero PDF
 *   bytes 时复用 PdfPreviewPane(source='zotero',无 synctex / 无编译态),
 *   否则显示引导空态。PDF 由 Ctrl+Click \cite{} 经 UIService.loadZoteroPaper 注入。
 */

import type React from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from '../../locales';
import { useZoteroPdf } from '../../services/core/hooks';
import { PdfPreviewPane } from './PdfPreviewPane';

export const ZoteroPaperPane: React.FC = () => {
  const { t } = useTranslation();
  const bytes = useZoteroPdf();

  if (!bytes) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
        <div className="text-center px-6">
          <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center">
            <FileText size={40} className="text-[var(--color-text-disabled)]" />
          </div>
          <p className="text-[var(--color-text-secondary)] font-medium">
            {t('zoteroPaper.empty')}
          </p>
        </div>
      </div>
    );
  }

  return <PdfPreviewPane source="zotero" />;
};
