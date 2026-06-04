/**
 * @file PreviewPanel.tsx - 右栏预览面板(预览 / 论文 双 tab)
 * @description 从原 MainLayout 的 RightPanelContent 抽出,逻辑不变。主页面拍平为
 *   单层三面板后,预览作为独立 Panel 直接渲染本组件。预览/论文 tab 切换、
 *   ZoteroPaperPane(论文 tab)行为与原实现一致。
 */

import type React from 'react';
import { memo } from 'react';
import { useRightPanelTab, usePreviewMode } from '../../services/core/hooks';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useTranslation } from '../../locales';
import { useLazyModule } from '../../hooks/useLazyModule';
import { PanelErrorBoundary } from '../ErrorBoundary';
import { PreviewLoadingFallback } from '../LoadingFallback';

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
  // iOS 分段控件:凹陷 track(bg-void)上浮起白色 active 药丸(bg-primary + 轻阴影),
  // 非活动透明 muted。取代旧的 2px 下划线 / accent 描边。
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
 * memo:切面板时 shell 重渲,但 previewTitle 稳定 → 跳过预览子树
 * (PreviewController / pdf.js)重渲。
 */
export const PreviewPanel = memo(PreviewPanelInner);
