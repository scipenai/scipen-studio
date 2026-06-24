import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../../src/renderer/src/components/research/PreviewPanel';

let rightPanelTab: 'preview' | 'paper' = 'preview';

const uiServiceMock = {
  setRightPanelTab: vi.fn((tab: 'preview' | 'paper') => {
    rightPanelTab = tab;
  }),
};

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useRightPanelTab: () => rightPanelTab,
  usePreviewMode: () => 'pdf',
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getUIService: () => uiServiceMock,
}));

vi.mock('../../../src/renderer/src/hooks/useLazyModule', () => ({
  useLazyModule: (loader: () => Promise<unknown>) => {
    const source = String(loader);
    if (source.includes('ZoteroPaperPane')) {
      return () => <div data-testid="paper-pane" />;
    }
    return () => <div data-testid="preview-controller" />;
  },
}));

vi.mock('../../../src/renderer/src/components/ErrorBoundary', () => ({
  PanelErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../src/renderer/src/components/LoadingFallback', () => ({
  PreviewLoadingFallback: () => <div data-testid="preview-loading" />,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'mainLayout.pdfPreview': 'PDF Preview',
        'mainLayout.paperTab': 'Paper',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('PreviewPanel', () => {
  beforeEach(() => {
    rightPanelTab = 'preview';
    vi.clearAllMocks();
  });

  it('renders preview and paper selectors as accessible tabs with selected state', () => {
    const { unmount } = render(<PreviewPanel previewTitle="PDF Preview" />);

    expect(screen.getByRole('tablist', { name: 'PDF Preview' })).toBeInTheDocument();

    const preview = screen.getByRole('tab', { name: 'PDF Preview' });
    expect(preview).toHaveAttribute('aria-selected', 'true');
    expect(preview).toHaveClass('cursor-pointer');
    expect(preview).toHaveClass('focus-visible:ring-2');

    const paper = screen.getByRole('tab', { name: 'Paper' });
    expect(paper).toHaveAttribute('aria-selected', 'false');
    expect(paper).toHaveClass('cursor-pointer');

    fireEvent.click(paper);
    expect(uiServiceMock.setRightPanelTab).toHaveBeenCalledWith('paper');

    unmount();
    render(<PreviewPanel previewTitle="PDF Preview" />);
    expect(screen.getByRole('tab', { name: 'Paper' })).toHaveAttribute('aria-selected', 'true');
  });
});
