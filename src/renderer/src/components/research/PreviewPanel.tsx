/**
 * @file PreviewPanel.tsx - 右栏预览面板(预览 / 论文 双 tab)
 * @description 从原 MainLayout 的 RightPanelContent 抽出,逻辑不变。主页面拍平为
 *   单层三面板后,预览作为独立 Panel 直接渲染本组件。预览/论文 tab 切换、
 *   ZoteroPaperPane(论文 tab)行为与原实现一致。
 */

import type React from 'react';
import { Suspense, lazy } from 'react';
import { useRightPanelTab, usePreviewMode } from '../../services/core/hooks';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useTranslation } from '../../locales';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { PreviewLoadingFallback } from '../LoadingFallback';

const PreviewController = lazy(() =>
  import('../preview/PreviewController').then((module) => ({ default: module.PreviewController }))
);

const ZoteroPaperPane = lazy(() =>
  import('../preview/ZoteroPaperPane').then((module) => ({ default: module.ZoteroPaperPane }))
);

/** 预览标题随 previewMode(pdf / markdown / typst)切换。 */
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

export function PreviewPanel({ previewTitle }: { previewTitle: string }): React.ReactElement {
  const { t } = useTranslation();
  const rightPanelTab = useRightPanelTab();

  const setTab = (tab: 'preview' | 'paper') => getUIService().setRightPanelTab(tab);
  // 紧凑文字 tab:活动 = 主文本色 + 2px accent 下划线;非活动 = muted。
  // 取代原 rounded-full 三重 accent 药丸(高亮收敛)。
  const tabBtn = (tab: 'preview' | 'paper', label: string) => {
    const active = rightPanelTab === tab;
    return (
      <button
        type="button"
        onClick={() => setTab(tab)}
        className="relative px-2.5 py-1 text-[13px] transition-colors"
        style={{
          color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        }}
      >
        {label}
        {active && (
          <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-[var(--color-accent)]" />
        )}
      </button>
    );
  };

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--color-bg-secondary)' }}
    >
      <div
        className="flex items-center gap-1 border-b px-2 py-1.5"
        style={{
          borderBottomColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
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
