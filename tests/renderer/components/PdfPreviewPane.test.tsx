import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPreviewPane } from '../../../src/renderer/src/components/preview/PdfPreviewPane';
import type { CompilationResult } from '../../../src/renderer/src/types';

const mockState = vi.hoisted(() => {
  const pdfPage = {
    getViewport: vi.fn(() => ({ width: 595, height: 842 })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };

  const pdfDoc = {
    numPages: 3,
    getPage: vi.fn(() => Promise.resolve(pdfPage)),
    destroy: vi.fn(),
  };

  return {
    requestAIErrorAnalysis: vi.fn(),
    compilationResult: null as CompilationResult | null,
    pdfData: null as Uint8Array | null,
    pdfDoc,
  };
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(() => ({ promise: Promise.resolve(mockState.pdfDoc) })),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/components/preview/CompileLogPanel', () => ({
  CompileLogPanel: () => <div data-testid="compile-log-panel" />,
}));

vi.mock('../../../src/renderer/src/services/core/FileOpenService', () => ({
  openFileInEditor: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/renderer/src/services/SyncTeXService', () => ({
  getSyncTeXService: () => ({
    backward: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/services/core/IdleTaskScheduler', () => ({
  TaskPriority: { Low: 'low' },
  cancelIdleTask: vi.fn(),
  scheduleIdleTask: vi.fn(),
}));

vi.mock('../../../src/renderer/src/utils/DOMScheduler', () => ({
  DOMScheduler: { schedule: vi.fn(), cancel: vi.fn() },
  SchedulePriority: { Low: 'low' },
}));

vi.mock('../../../src/renderer/src/components/preview/usePdfMotion', () => ({
  usePulseHighlight: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getEditorService: () => ({ activeTabPath: 'D:/paper/main.tex' }),
  getProjectService: () => ({ projectPath: 'D:/paper' }),
  getUIService: () => ({
    requestAIErrorAnalysis: mockState.requestAIErrorAnalysis,
    setPdfHighlight: vi.fn(),
    synctexPath: null,
    synctexProjectRoot: null,
  }),
}));

const failedResult: CompilationResult = {
  success: false,
  errors: ['Undefined control sequence'],
  log: 'raw line 1\nraw line 2',
  time: 1200,
  parsedErrors: [
    {
      level: 'error',
      file: 'main.tex',
      line: 12,
      message: 'Undefined control sequence',
      content: 'l.12 \\badcommand',
    },
  ],
  parsedWarnings: [],
  parsedInfo: [],
};

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useCompilationResult: () => mockState.compilationResult,
  useActiveTabPath: () => 'D:/paper/main.tex',
  useIsCompiling: () => false,
  usePdfData: () => mockState.pdfData,
  usePdfHighlight: () => null,
  useZoteroPdf: () => null,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'pdfPreview.compileFailed': 'Compile failed',
        'pdfPreview.fixIssuesHint': 'Fix issues to refresh preview.',
        'pdfPreview.recompile': 'Recompile',
        'pdfPreview.aiAnalysisSummary': 'Compile failure',
        'pdfPreview.askAgent': 'Ask agent',
        'pdfPreview.errorUnit': 'errors',
        'pdfPreview.warningUnit': 'warnings',
        'pdfPreview.timeTaken': `${params?.time ?? '0'}s`,
        'pdfPreview.primaryIssue': 'Primary issue',
        'pdfPreview.jumpToError': 'Jump to error',
        'pdfPreview.noStructuredErrors': 'No structured errors',
        'pdfPreview.diagnosticWorkbench': 'Diagnostic workbench',
        'pdfPreview.detailedLog': 'Detailed log',
        'pdfPreview.fullRawLog': 'Full raw log',
        'pdfPreview.copyLog': 'Copy log',
        'pdfPreview.pdfPreviewTab': 'PDF Preview',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('PdfPreviewPane', () => {
  beforeEach(() => {
    mockState.requestAIErrorAnalysis.mockClear();
    mockState.compilationResult = failedResult;
    mockState.pdfData = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  });

  it('labels compile failure actions and diagnostic tabs for keyboard users', () => {
    render(<PdfPreviewPane />);

    expect(screen.getByRole('button', { name: 'Recompile' })).toHaveClass('cursor-pointer');

    const askAgent = screen.getByRole('button', { name: 'Ask agent' });
    expect(askAgent).toHaveClass('cursor-pointer');
    fireEvent.click(askAgent);
    expect(mockState.requestAIErrorAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'Undefined control sequence',
        file: 'main.tex',
        line: 12,
      })
    );

    expect(screen.getByRole('button', { name: 'Jump to error' })).toHaveClass('cursor-pointer');

    const detailed = screen.getByRole('button', { name: 'Detailed log' });
    const raw = screen.getByRole('button', { name: 'Full raw log' });
    expect(detailed).toHaveAttribute('aria-pressed', 'true');
    expect(raw).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(raw);
    expect(raw).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Copy log' })).toHaveClass('cursor-pointer');
  });

  it('labels PDF toolbar icon controls and exposes toggle state', async () => {
    mockState.compilationResult = { success: true };
    mockState.pdfData = new Uint8Array([1, 2, 3, 4]);

    render(<PdfPreviewPane />);

    expect(await screen.findByText('PDF Preview')).toBeInTheDocument();

    const thumbnails = screen.getByRole('button', { name: 'Show thumbnails' });
    expect(thumbnails).toHaveAttribute('aria-pressed', 'false');
    expect(thumbnails).toHaveClass('cursor-pointer');
    expect(thumbnails).toHaveClass('focus-visible:ring-2');

    const previous = screen.getByRole('button', { name: 'Previous page' });
    expect(previous).toBeDisabled();
    expect(previous).toHaveClass('cursor-not-allowed');

    expect(screen.getByRole('button', { name: 'Next page' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Fit to width' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Single page mode' })).toHaveClass(
      'cursor-pointer'
    );
    expect(screen.getByRole('button', { name: 'Download PDF' })).toHaveClass('cursor-pointer');
  });
});
