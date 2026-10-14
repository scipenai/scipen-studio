import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../../src/renderer/src/components/research/PreviewPanel';

let rightPanelTab: 'preview' | 'paper' = 'preview';
let zoteroPdf: { itemKey: string; pdfBytes: Uint8Array } | null = null;

const uiServiceMock = {
  setRightPanelTab: vi.fn((tab: 'preview' | 'paper') => {
    rightPanelTab = tab;
  }),
  get zoteroPdf() {
    return zoteroPdf;
  },
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

describe('PreviewPanel (merged single-surface preview)', () => {
  beforeEach(() => {
    rightPanelTab = 'preview';
    zoteroPdf = null;
    vi.clearAllMocks();
  });

  it('renders the compile preview by default with no visible tabs', () => {
    render(<PreviewPanel />);
    expect(screen.getByTestId('preview-controller')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('hands the pane to the paper reader when the paper tab is active', () => {
    rightPanelTab = 'paper';
    render(<PreviewPanel />);
    expect(screen.getByTestId('paper-pane')).toBeInTheDocument();
  });

  it('falls back to the compile preview when routed to paper with no paper loaded', () => {
    rightPanelTab = 'paper';
    zoteroPdf = null;
    render(<PreviewPanel />);
    expect(uiServiceMock.setRightPanelTab).toHaveBeenCalledWith('preview');
  });

  it('keeps the paper pane when a paper is loaded', () => {
    rightPanelTab = 'paper';
    zoteroPdf = { itemKey: 'KEY1', pdfBytes: new Uint8Array(4) };
    render(<PreviewPanel />);
    expect(uiServiceMock.setRightPanelTab).not.toHaveBeenCalled();
    expect(screen.getByTestId('paper-pane')).toBeInTheDocument();
  });
});
