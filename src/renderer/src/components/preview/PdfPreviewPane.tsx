/**
 * @file PdfPreviewPane.tsx - PDF Preview Panel
 * @description Real-time PDF preview component with zoom, pagination, SyncTeX bidirectional sync
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Columns,
  Download,
  FileText,
  Grid3X3,
  Maximize2,
  Sidebar,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
// Use the `legacy/` build: it ships core-js polyfills (incl. Promise.try) for older
// Chromium versions. Electron 30 (Chromium 124) lacks Promise.try, so the modern build
// crashes at runtime. See feedback_electron_dep_pinning memory.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openFileInEditor } from '../../services/core/FileOpenService';
import { getSyncTeXService } from '../../services/SyncTeXService';
import {
  TaskPriority,
  cancelIdleTask,
  scheduleIdleTask,
} from '../../services/core/IdleTaskScheduler';
import {
  getEditorService,
  getProjectService,
  getUIService,
} from '../../services/core/ServiceRegistry';
import {
  useCompilationResult,
  useActiveTabPath,
  useIsCompiling,
  usePdfData,
  usePdfHighlight,
  useZoteroPdf,
} from '../../services/core/hooks';
import { DOMScheduler, SchedulePriority } from '../../utils/DOMScheduler';
import type { PdfHighlight } from '../../services/core';
import { useTranslation } from '../../locales';
import { CompileLogPanel } from './CompileLogPanel';
import { usePulseHighlight } from './usePdfMotion';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// CMap URL required for CJK character rendering (resolved at runtime)
const CMAP_URL = new URL(/* @vite-ignore */ 'pdfjs-dist/cmaps/', import.meta.url).toString();

// Thumbnail generation task ID for scheduler deduplication and cancellation
const THUMBNAIL_TASK_ID = 'preview-generate-thumbnails';

// Using memo to prevent unnecessary re-renders
const Thumbnail = memo<{
  pageNum: number;
  isActive: boolean;
  imageData: string | null;
  onClick: () => void;
}>(({ pageNum, isActive, imageData, onClick }) => (
  <div
    onClick={onClick}
    className={clsx(
      'cursor-pointer rounded overflow-hidden border-2 transition-all',
      isActive
        ? 'border-[var(--color-accent)] shadow-lg shadow-[var(--color-accent)]/20'
        : 'border-transparent hover:border-[var(--color-border-strong)]'
    )}
  >
    {imageData ? (
      <img src={imageData} alt={`Page ${pageNum}`} className="w-full" loading="lazy" />
    ) : (
      <div className="aspect-[3/4] bg-[var(--color-bg-tertiary)] flex items-center justify-center">
        <span className="text-xs text-[var(--color-text-muted)]">{pageNum}</span>
      </div>
    )}
    <div className="text-center text-xs text-[var(--color-text-muted)] py-1 bg-[var(--color-bg-secondary)]">
      {pageNum}
    </div>
  </div>
));
Thumbnail.displayName = 'Thumbnail';

const PDFPage = memo<{
  pageNum: number;
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  scale: number;
  isVisible: boolean;
  highlight?: PdfHighlight | null;
  onRendered?: () => void;
  onPageClick?: (pageNum: number, x: number, y: number) => void;
}>(({ pageNum, pdfDoc, scale, isVisible, highlight, onRendered, onPageClick }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const [isRendered, setIsRendered] = useState(false);
  const renderingRef = useRef(false);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);

  // SyncTeX landing pulse: latch a snapshot of the non-null highlight and bump a token to trigger one animation.
  // The parent clearing highlight to null ~500ms later (to drop navigation state) won't interrupt the latched pulse — fully decoupled.
  const pulseTokenRef = useRef(0);
  const [pulse, setPulse] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    token: number;
  } | null>(null);

  useEffect(() => {
    if (!highlight) return;
    pulseTokenRef.current += 1;
    setPulse({
      x: highlight.x,
      y: highlight.y,
      width: highlight.width,
      height: highlight.height,
      token: pulseTokenRef.current,
    });
  }, [highlight]);

  usePulseHighlight(pageRef, pulseRef, pulse?.token ?? 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isVisible || renderingRef.current) return;

    const renderPage = async () => {
      renderingRef.current = true;
      try {
        const page = await pdfDoc.getPage(pageNum);
        const context = canvas.getContext('2d');
        if (!context) return;

        const devicePixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * devicePixelRatio });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / devicePixelRatio}px`;
        canvas.style.height = `${viewport.height / devicePixelRatio}px`;

        renderTaskRef.current?.cancel();

        // PDF.js type definitions incomplete: render() requires canvas property but type doesn't declare it
        const task = page.render({
          canvasContext: context,
          viewport: viewport,
          canvas: canvas,
        }) as { promise: Promise<void>; cancel(): void };
        renderTaskRef.current = task;
        await task.promise;

        setIsRendered(true);
        onRendered?.();
      } catch (error) {
        // RenderingCancelledException is expected when cancelling stale renders
        if ((error as { name?: string })?.name === 'RenderingCancelledException') return;
        console.error(`Failed to render page ${pageNum}:`, error);
      } finally {
        renderingRef.current = false;
      }
    };

    renderPage();

    return () => {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [pdfDoc, pageNum, scale, isVisible, onRendered]);

  useEffect(() => {
    setIsRendered(false);
    renderingRef.current = false;
  }, [scale]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onPageClick || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();

      // Convert CSS pixels to PDF points: divide by scale (canvas display size = PDF size * scale)
      // SyncTeX uses same coordinate system as canvas (origin top-left, Y downward)
      const xPdf = (e.clientX - rect.left) / scale;
      const yPdf = (e.clientY - rect.top) / scale;

      onPageClick(pageNum, xPdf, yPdf);
    },
    [pageNum, scale, onPageClick]
  );

  return (
    <div
      ref={pageRef}
      className="bg-white shadow-2xl relative flex-shrink-0"
      style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        className="cursor-crosshair"
        title="Click to jump to corresponding source code location"
      />
      {!isRendered && isVisible && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <div className="w-6 h-6 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {/* SyncTeX landing pulse layer: visibility/scale is fully delegated to GSAP (autoAlpha); style does not declare opacity/visibility/transform
          to avoid parent re-renders overriding the animation; pointer-events-none as a safety net so it never blocks reverse-sync clicks. */}
      {pulse && (
        <div
          ref={pulseRef}
          aria-hidden
          className="pointer-events-none absolute rounded-[3px]"
          style={{
            left: pulse.x * scale,
            top: pulse.y * scale,
            width: Math.max(pulse.width * scale, 24),
            height: Math.max(pulse.height * scale, 14),
            border: '2px solid var(--color-accent)',
            background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
            boxShadow:
              '0 0 0 4px color-mix(in srgb, var(--color-accent) 26%, transparent), 0 0 20px 2px color-mix(in srgb, var(--color-accent) 50%, transparent)',
          }}
        />
      )}
    </div>
  );
});
PDFPage.displayName = 'PDFPage';

export const PdfPreviewPane: React.FC<{ source?: 'compile' | 'zotero' }> = ({
  source = 'compile',
}) => {
  // Both data hooks are called unconditionally (rules of hooks), then we pick by source. The zotero source is a Zotero
  // paper PDF (no synctex / no compile state); the compile source is the compilation artifact (default, behavior unchanged).
  const compilePdfData = usePdfData();
  const zoteroPdfData = useZoteroPdf();
  const pdfData = source === 'zotero' ? zoteroPdfData : compilePdfData;

  const rawIsCompiling = useIsCompiling();
  const rawCompilationResult = useCompilationResult();
  const isCompiling = source === 'zotero' ? false : rawIsCompiling;
  const compilationResult = source === 'zotero' ? null : rawCompilationResult;

  const pdfHighlight = usePdfHighlight();
  const activeTabPath = useActiveTabPath();
  const uiService = getUIService();
  const { t } = useTranslation();

  const [scale, setScale] = useState(1.2);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const [viewMode, setViewMode] = useState<'scroll' | 'single'>('scroll');
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1, 2, 3]));
  const [showLogPanel, setShowLogPanel] = useState(false);
  const [failureLogTab, setFailureLogTab] = useState<'diagnostics' | 'raw'>('diagnostics');
  const [zoomInput, setZoomInput] = useState('120');
  const compileLogCompilerType: 'LaTeX' | 'Typst' = activeTabPath?.toLowerCase().endsWith('.typ')
    ? 'Typst'
    : 'LaTeX';

  const normalizeLogStrings = useCallback((entries: unknown[] | undefined): string[] => {
    return (entries ?? []).map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry === 'object') {
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.message === 'string' && candidate.message.trim()) {
          return candidate.message.trim();
        }
        try {
          return JSON.stringify(candidate);
        } catch {
          return String(candidate);
        }
      }
      return String(entry);
    });
  }, []);

  // Thumbnail generation task version token for canceling stale tasks
  const thumbnailGenerationTokenRef = useRef(0);

  const hasLogs =
    compilationResult &&
    ((compilationResult.parsedErrors?.length ?? 0) > 0 ||
      (compilationResult.parsedWarnings?.length ?? 0) > 0 ||
      (compilationResult.parsedInfo?.length ?? 0) > 0);
  const hasFallbackDiagnostics =
    (compilationResult?.errors?.length ?? 0) > 0 || (compilationResult?.warnings?.length ?? 0) > 0;

  // Auto-show log panel on compilation failure to surface errors immediately
  useEffect(() => {
    if (compilationResult && !compilationResult.success && hasLogs) {
      setShowLogPanel(true);
    }
  }, [compilationResult, hasLogs]);

  useEffect(() => {
    if (compilationResult && !compilationResult.success) {
      setFailureLogTab(hasLogs || hasFallbackDiagnostics ? 'diagnostics' : 'raw');
    }
  }, [compilationResult, hasFallbackDiagnostics, hasLogs]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const currentZoomPercent = Math.round(scale * 100);
  const presetZoomOptions = useMemo(() => [50, 75, 100, 125, 150, 200], []);
  const zoomSelectValue = presetZoomOptions.includes(currentZoomPercent)
    ? String(currentZoomPercent)
    : 'custom';

  const jumpToCompileLocation = useCallback(async (file: string, line: number) => {
    const projectPath = getProjectService().projectPath;
    const normalizedProject = projectPath?.replace(/\\/g, '/');
    const relativeFile = file.replace(/^\.?\//, '').replace(/\\/g, '/');

    let targetPath = relativeFile;
    if (normalizedProject && !/^(?:[A-Za-z]:[\\/]|\/)/.test(relativeFile)) {
      targetPath = `${normalizedProject.replace(/\/$/, '')}/${relativeFile}`;
    }

    try {
      await openFileInEditor(targetPath);
    } catch (error) {
      console.error('Failed to open compile error file:', error);
    }

    const currentActive = getEditorService().activeTabPath;
    const finalPath = currentActive?.endsWith(relativeFile) ? currentActive : targetPath;
    window.dispatchEvent(
      new CustomEvent('synctex-goto-line', {
        detail: {
          file: finalPath,
          line,
          column: 1,
        },
      })
    );
  }, []);

  useEffect(() => {
    if (pdfData) {
      try {
        const copy = new Uint8Array(pdfData).slice();
        setPdfBytes(copy);
        loadPdfDoc(copy);
      } catch (error) {
        console.error('Failed to copy PDF data:', error);
      }
    } else {
      setPdfBytes(null);
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
      setPdfDoc(null);
      setTotalPages(0);
      setThumbnails(new Map());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadPdfDoc is a stable function
  }, [pdfData]);

  const loadPdfDoc = async (data: Uint8Array | null) => {
    if (!data) return;

    setIsInitialLoading(true);

    try {
      const loadingParams: {
        data: ArrayBuffer;
        disableFontFace: boolean;
        useSystemFonts: boolean;
        cMapUrl: string;
        cMapPacked: boolean;
      } = {
        data: data.buffer.slice(0) as ArrayBuffer,
        disableFontFace: false,
        useSystemFonts: true,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
      };

      const loadingTask = pdfjsLib.getDocument(loadingParams);
      const doc = await loadingTask.promise;

      pdfDocRef.current?.destroy();
      pdfDocRef.current = doc;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);
      setVisiblePages(new Set([1, 2, 3]));
      setThumbnails(new Map());

      // Thumbnails are lazy-generated on demand; here we only seed the range around the first visible page.
      cancelIdleTask(THUMBNAIL_TASK_ID);
      thumbnailGenerationTokenRef.current += 1;
    } catch (error) {
      console.error('Failed to load PDF:', error);
    } finally {
      setIsInitialLoading(false);
    }
  };

  // Clean up thumbnail task and PDF document on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cancelIdleTask(THUMBNAIL_TASK_ID);
      thumbnailGenerationTokenRef.current += 1;
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, []);

  useEffect(() => {
    setZoomInput(String(currentZoomPercent));
  }, [currentZoomPercent]);

  useEffect(() => {
    // SyncTeX forward highlight is exclusive to compilation artifacts; zotero paper PDFs have no synctex, skip.
    if (source === 'zotero') return;
    if (!pdfHighlight || !pdfDoc || !pagesContainerRef.current) return;

    const { page } = pdfHighlight;

    if (page < 1 || page > totalPages) {
      console.warn('SyncTeX: Invalid page number', page);
      return;
    }

    setCurrentPage(page);

    setVisiblePages((prev) => {
      const newSet = new Set(prev);
      for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
        newSet.add(i);
      }
      return newSet;
    });

    setTimeout(() => {
      const pageElement = pagesContainerRef.current?.querySelector(`[data-page="${page}"]`);
      if (pageElement) {
        pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);

    // Clear highlight state to prevent repeated navigation
    setTimeout(() => {
      uiService.setPdfHighlight(null);
    }, 500);
  }, [source, pdfHighlight, pdfDoc, totalPages, uiService]);

  // Use IntersectionObserver for virtual scrolling: detect visible pages
  // Use functional state updates to avoid including visiblePages in deps and prevent infinite loops
  useEffect(() => {
    if (!pagesContainerRef.current || viewMode !== 'scroll') return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Use functional update to avoid closure capturing stale visiblePages value
        setVisiblePages((prev) => {
          const newVisible = new Set(prev);

          entries.forEach((entry) => {
            const pageNum = Number.parseInt(entry.target.getAttribute('data-page') || '0');
            if (entry.isIntersecting) {
              for (let i = Math.max(1, pageNum - 2); i <= Math.min(totalPages, pageNum + 2); i++) {
                newVisible.add(i);
              }
            }
          });

          return newVisible;
        });
      },
      {
        root: containerRef.current,
        rootMargin: '200px 0px', // Preload pages before they become visible
        threshold: 0.1,
      }
    );

    const pages = pagesContainerRef.current.querySelectorAll('[data-page]');
    pages.forEach((page) => observerRef.current?.observe(page));

    return () => observerRef.current?.disconnect();
  }, [totalPages, viewMode]); // Removed visiblePages from deps, using functional updates instead

  const generateThumbnailRange = useCallback(
    async (
      doc: pdfjsLib.PDFDocumentProxy,
      generationToken: number,
      startPage: number,
      endPage: number
    ) => {
      if (generationToken !== thumbnailGenerationTokenRef.current) {
        return;
      }

      for (let pageNum = startPage; pageNum <= endPage; pageNum += 1) {
        if (generationToken !== thumbnailGenerationTokenRef.current) {
          return;
        }
        try {
          const page = await doc.getPage(pageNum);
          if (generationToken !== thumbnailGenerationTokenRef.current) {
            return;
          }

          const viewport = page.getViewport({ scale: 0.15 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          const context = canvas.getContext('2d');
          if (context) {
            await (
              page.render({
                canvasContext: context,
                viewport,
                canvas,
              }) as { promise: Promise<void> }
            ).promise;

            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            setThumbnails((prev) => {
              if (prev.has(pageNum)) return prev;
              const next = new Map(prev);
              next.set(pageNum, dataUrl);
              return next;
            });
          }

          await new Promise((resolve) => setTimeout(resolve, 8));
        } catch (error) {
          console.error(`Failed to generate thumbnail for page ${pageNum}:`, error);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!pdfDoc || !showThumbnails) return;

    cancelIdleTask(THUMBNAIL_TASK_ID);
    thumbnailGenerationTokenRef.current += 1;
    const generationToken = thumbnailGenerationTokenRef.current;
    const startPage = Math.max(1, currentPage - 4);
    const endPage = Math.min(totalPages, currentPage + 6);

    scheduleIdleTask(() => generateThumbnailRange(pdfDoc, generationToken, startPage, endPage), {
      id: THUMBNAIL_TASK_ID,
      priority: TaskPriority.Low,
      timeout: 3000,
    });
  }, [currentPage, generateThumbnailRange, pdfDoc, showThumbnails, totalPages]);

  // Listen to scroll to update current page (optimized with DOMScheduler)
  // DOMScheduler automatically batches high-frequency scroll events to prevent layout thrashing
  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewMode !== 'scroll') return;

    const handleScroll = () => {
      // Use DOMScheduler to batch page detection calls automatically
      DOMScheduler.schedule(
        'preview-scroll-page-detect',
        () => {
          const pages = pagesContainerRef.current?.querySelectorAll('[data-page]');
          if (!pages) return;

          const containerRect = container.getBoundingClientRect();
          const centerY = containerRect.top + containerRect.height / 2;

          for (const page of pages) {
            const rect = page.getBoundingClientRect();
            if (rect.top <= centerY && rect.bottom >= centerY) {
              const pageNum = Number.parseInt(page.getAttribute('data-page') || '1');
              setCurrentPage(pageNum);
              break;
            }
          }
        },
        SchedulePriority.Low
      ); // Low priority, can be preempted by more important tasks
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      DOMScheduler.cancel('preview-scroll-page-detect');
    };
  }, [viewMode]);

  const goToPage = useCallback(
    (pageNum: number) => {
      if (pageNum < 1 || pageNum > totalPages) return;
      setCurrentPage(pageNum);

      if (viewMode === 'scroll') {
        const pageElement = pagesContainerRef.current?.querySelector(`[data-page="${pageNum}"]`);
        if (pageElement) {
          pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    },
    [totalPages, viewMode]
  );

  const fitToWidth = useCallback(() => {
    if (!containerRef.current || !pdfDoc) return;

    pdfDoc.getPage(1).then((page) => {
      const containerStyle = window.getComputedStyle(containerRef.current!);
      const horizontalPadding =
        Number.parseFloat(containerStyle.paddingLeft || '0') +
        Number.parseFloat(containerStyle.paddingRight || '0');
      const containerWidth = containerRef.current!.clientWidth - horizontalPadding - 24;
      const viewport = page.getViewport({ scale: 1 });
      const newScale = containerWidth / viewport.width;
      setScale(Math.min(Math.max(newScale, 0.5), 3));
    });
  }, [pdfDoc]);

  // After every new PDF document load (switching files / sources / recompiling all produce a new pdfDoc instance),
  // default to fitting container width instead of a fixed 120% — reuse fitToWidth; the container is already mounted by then.
  useEffect(() => {
    if (!pdfDoc || totalPages === 0) return;
    fitToWidth();
  }, [pdfDoc, totalPages, fitToWidth]);

  const handleZoomInputCommit = useCallback(() => {
    const parsed = Number.parseInt(zoomInput, 10);
    if (Number.isNaN(parsed)) {
      setZoomInput(String(currentZoomPercent));
      return;
    }
    const clamped = Math.min(300, Math.max(50, parsed));
    setScale(clamped / 100);
  }, [currentZoomPercent, zoomInput]);

  const handleDownload = useCallback(() => {
    if (pdfBytes) {
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const currentName =
        compilationResult?.pdfPath?.split(/[\\/]/).pop() ||
        activeTabPath
          ?.replace(/\\/g, '/')
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '.pdf') ||
        'document.pdf';
      a.download = currentName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [activeTabPath, compilationResult?.pdfPath, pdfBytes]);

  const zoomIn = useCallback(() => setScale((s) => Math.min(3, s + 0.1)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(0.5, s - 0.1)), []);
  const handleScaleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === 'custom') {
      return;
    }
    setScale(Number(e.target.value) / 100);
  }, []);

  // PDF page click handler (SyncTeX reverse sync: navigate from PDF to source code)
  const handlePageClick = useCallback(async (pageNum: number, x: number, y: number) => {
    const uiService = getUIService();
    const synctexPath = uiService.synctexPath;

    try {
      const syncTeXService = getSyncTeXService();
      const result = await syncTeXService.backward(
        pageNum,
        x,
        y,
        synctexPath,
        uiService.synctexProjectRoot ?? undefined
      );

      if (result?.file && result.line !== undefined) {
        window.dispatchEvent(
          new CustomEvent('synctex-goto-line', {
            detail: {
              file: result.file,
              line: result.line,
              column: result.column || 1,
            },
          })
        );
      }
    } catch (error) {
      console.error('SyncTeX backward failed:', error);
    }
  }, []);

  // zotero paper PDFs have no .synctex → disable reverse-sync clicks (pass undefined to turn off),
  // avoiding backward() throwing when synctexPath is missing.
  const pageClickHandler = source === 'zotero' ? undefined : handlePageClick;

  // SyncTeX landing highlight only exists for compilation artifacts (zotero papers have no synctex); only forward to the hit page, others get null.
  const activeHighlight = source === 'zotero' ? null : pdfHighlight;

  const pageNumbers = useMemo(
    () => Array.from({ length: totalPages }, (_, i) => i + 1),
    [totalPages]
  );

  if (isCompiling) {
    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-[var(--color-text-muted)]">
            <div className="w-12 h-12 border-3 border-[var(--color-accent)] border-t-transparent rounded-full mx-auto mb-4 animate-spin" />
            <p className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('preview.compiling')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isInitialLoading) {
    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-[var(--color-text-muted)]">
            <div className="w-10 h-10 border-2 border-[var(--color-accent)] border-t-transparent rounded-full mx-auto mb-4 animate-spin" />
            <p className="text-sm font-medium">{t('preview.loadingPdf')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (compilationResult && !compilationResult.success) {
    const parsedErrors = compilationResult.parsedErrors ?? [];
    const parsedWarnings = compilationResult.parsedWarnings ?? [];
    const parsedInfo = compilationResult.parsedInfo ?? [];
    const primaryIssue = parsedErrors[0] || parsedWarnings[0] || parsedInfo[0] || null;
    const errorCount = parsedErrors.length || compilationResult.errors?.length || 0;
    const warningCount = parsedWarnings.length || compilationResult.warnings?.length || 0;
    const hasStructuredLogs =
      parsedErrors.length > 0 || parsedWarnings.length > 0 || parsedInfo.length > 0;
    const rawLog = compilationResult.log?.trim() || '';
    const allEntries = [...parsedErrors, ...parsedWarnings, ...parsedInfo];
    const primaryIssueContent = primaryIssue?.content?.trim();
    const primaryIssueText =
      primaryIssueContent && primaryIssueContent !== primaryIssue.message
        ? primaryIssueContent
        : null;

    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
        <div
          className="border-b px-4 py-3"
          style={{
            borderBottomColor: 'color-mix(in srgb, var(--color-error) 18%, transparent)',
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--color-error-muted) 74%, var(--color-bg-elevated) 26%) 0%, color-mix(in srgb, var(--color-bg-elevated) 96%, transparent) 100%)',
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--color-error-muted)] text-[var(--color-error)]">
                <AlertCircle size={18} aria-hidden="true" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {t('pdfPreview.compileFailed')}
                </div>
                <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  {t('pdfPreview.fixIssuesHint')}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('trigger-compile'))}
                className="cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'color-mix(in srgb, var(--color-bg-primary) 84%, transparent)',
                }}
              >
                {t('pdfPreview.recompile')}
              </button>
              <button
                type="button"
                onClick={() =>
                  uiService.requestAIErrorAnalysis({
                    summaryTitle: t('pdfPreview.aiAnalysisSummary'),
                    errorMessage:
                      primaryIssue?.message ||
                      compilationResult.errors?.[0] ||
                      t('pdfPreview.compileFailed'),
                    errorContent: primaryIssue?.content?.trim(),
                    file: primaryIssue?.file,
                    line: primaryIssue?.line ?? undefined,
                    compilerType: compileLogCompilerType,
                    relatedEntries: allEntries,
                    rawLog,
                  })
                }
                className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,#0ea5e9_0%,#2563eb_100%)] px-3.5 py-2 text-xs font-semibold text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)] transition-transform hover:-translate-y-[1px] hover:shadow-[0_16px_28px_rgba(37,99,235,0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <Sparkles size={12} aria-hidden="true" />
                <span>{t('pdfPreview.askAgent')}</span>
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <div
              className="rounded-xl border px-3 py-2 text-xs text-[var(--color-text-secondary)]"
              style={{
                borderColor: 'var(--color-border)',
                background: 'color-mix(in srgb, var(--color-bg-primary) 84%, transparent)',
              }}
            >
              <span className="font-medium text-[var(--color-error)]">{errorCount}</span>{' '}
              {t('pdfPreview.errorUnit')}
            </div>
            <div
              className="rounded-xl border px-3 py-2 text-xs text-[var(--color-text-secondary)]"
              style={{
                borderColor: 'var(--color-border)',
                background: 'color-mix(in srgb, var(--color-bg-primary) 84%, transparent)',
              }}
            >
              <span className="font-medium text-[var(--color-warning)]">{warningCount}</span>{' '}
              {t('pdfPreview.warningUnit')}
            </div>
            {compilationResult.time && (
              <div
                className="rounded-xl border px-3 py-2 text-xs text-[var(--color-text-secondary)]"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'color-mix(in srgb, var(--color-bg-primary) 84%, transparent)',
                }}
              >
                {t('pdfPreview.timeTaken', { time: (compilationResult.time / 1000).toFixed(2) })}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {primaryIssue ? (
            <div
              className="rounded-2xl p-4 shadow-[var(--shadow-md)]"
              style={{
                background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
              }}
            >
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                {t('pdfPreview.primaryIssue')}
              </div>
              <div className="mt-3 text-base font-semibold text-[var(--color-text-primary)]">
                {primaryIssue.message}
              </div>
              {primaryIssue.file && (
                <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  {primaryIssue.file}
                  {primaryIssue.line ? `:${primaryIssue.line}` : ''}
                </div>
              )}
              {primaryIssueText && (
                <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--color-bg-secondary)] p-3 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono">
                  {primaryIssueText}
                </pre>
              )}
              {primaryIssue.file && primaryIssue.line && (
                <button
                  type="button"
                  onClick={() => {
                    void jumpToCompileLocation(primaryIssue.file!, primaryIssue.line!);
                  }}
                  className="mt-3 cursor-pointer rounded-lg bg-[var(--color-accent-muted)] px-3 py-2 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  {t('pdfPreview.jumpToError')}
                </button>
              )}
            </div>
          ) : (
            <div
              className="rounded-2xl p-4 text-sm text-[var(--color-text-secondary)] shadow-[var(--shadow-md)]"
              style={{
                background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
              }}
            >
              {t('pdfPreview.noStructuredErrors')}
            </div>
          )}

          {(hasStructuredLogs || hasFallbackDiagnostics || rawLog) && (
            <div
              className="mt-4 overflow-hidden rounded-2xl shadow-[var(--shadow-md)]"
              style={{
                background: 'color-mix(in srgb, var(--color-bg-elevated) 96%, transparent)',
              }}
            >
              <div
                className="flex items-center justify-between gap-3 border-b px-4 py-3"
                style={{ borderBottomColor: 'var(--color-border-subtle)' }}
              >
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {t('pdfPreview.diagnosticWorkbench')}
                </h3>
                <div className="flex items-center gap-2">
                  {(hasStructuredLogs || hasFallbackDiagnostics) && (
                    <button
                      type="button"
                      onClick={() => setFailureLogTab('diagnostics')}
                      aria-pressed={failureLogTab === 'diagnostics'}
                      className={clsx(
                        'cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                        failureLogTab === 'diagnostics'
                          ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                      )}
                      style={
                        failureLogTab === 'diagnostics'
                          ? undefined
                          : { background: 'var(--color-bg-hover)' }
                      }
                    >
                      {t('pdfPreview.detailedLog')}
                    </button>
                  )}
                  {rawLog && (
                    <button
                      type="button"
                      onClick={() => setFailureLogTab('raw')}
                      aria-pressed={failureLogTab === 'raw'}
                      className={clsx(
                        'cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                        failureLogTab === 'raw'
                          ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                      )}
                      style={
                        failureLogTab === 'raw'
                          ? undefined
                          : { background: 'var(--color-bg-hover)' }
                      }
                    >
                      {t('pdfPreview.fullRawLog')}
                    </button>
                  )}
                </div>
              </div>

              <div className="p-4">
                {failureLogTab === 'diagnostics' ? (
                  hasStructuredLogs ? (
                    <div
                      className="overflow-hidden rounded-2xl border"
                      style={{ borderColor: 'var(--color-border-subtle)' }}
                    >
                      <CompileLogPanel
                        errors={parsedErrors}
                        warnings={parsedWarnings}
                        info={parsedInfo}
                        embedded
                        showHeader={false}
                        onJumpToLine={(file, line) => {
                          void jumpToCompileLocation(file, line);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {normalizeLogStrings(compilationResult.errors).map((entry, index) => (
                        <div
                          // eslint-disable-next-line react/no-array-index-key -- raw compile log lines, may contain duplicates, index is stable per render
                          key={`raw-error-${index}`}
                          className="rounded-xl bg-[var(--color-error-muted)] px-3 py-2 text-sm text-[var(--color-error)]"
                        >
                          {entry}
                        </div>
                      ))}
                      {normalizeLogStrings(compilationResult.warnings).map((entry, index) => (
                        <div
                          // eslint-disable-next-line react/no-array-index-key -- raw compile log lines, may contain duplicates, index is stable per render
                          key={`raw-warning-${index}`}
                          className="rounded-xl bg-[var(--color-warning-muted)] px-3 py-2 text-sm text-[var(--color-warning)]"
                        >
                          {entry}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  <div
                    className="overflow-hidden rounded-2xl border bg-[var(--color-bg-primary)]"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div
                      className="flex items-center justify-end border-b px-4 py-3"
                      style={{ borderBottomColor: 'var(--color-border-subtle)' }}
                    >
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(rawLog)}
                        className="cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                        style={{
                          borderColor: 'var(--color-border)',
                          background:
                            'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
                        }}
                      >
                        {t('pdfPreview.copyLog')}
                      </button>
                    </div>
                    <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all px-4 py-4 text-xs leading-6 text-[var(--color-text-secondary)] font-mono">
                      {rawLog}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (pdfDoc && totalPages > 0) {
    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
        <div
          className="flex min-h-[54px] items-center justify-between border-b px-4 py-2.5"
          style={{
            borderBottomColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-[var(--color-accent)] ring-1 ring-inset"
              style={{
                background: 'var(--color-accent-muted)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
              }}
            >
              {t('pdfPreview.pdfPreviewTab')}
            </div>
            <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />
            <button
              type="button"
              onClick={() => setShowThumbnails(!showThumbnails)}
              aria-label="Show thumbnails"
              aria-pressed={showThumbnails}
              className={clsx(
                'cursor-pointer rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                showThumbnails
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
              title="Show thumbnails"
            >
              <Sidebar size={16} aria-hidden="true" />
            </button>
            <span className="text-sm text-[var(--color-text-secondary)] min-w-[60px] text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              className={clsx(
                'rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-30',
                currentPage <= 1 ? 'cursor-not-allowed' : 'cursor-pointer'
              )}
              title="Previous page"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              className={clsx(
                'rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-30',
                currentPage >= totalPages ? 'cursor-not-allowed' : 'cursor-pointer'
              )}
              title="Next page"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom out"
              className="cursor-pointer rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              title="Zoom out"
            >
              <ZoomOut size={16} aria-hidden="true" />
            </button>
            <div className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1">
              <input
                value={zoomInput}
                onChange={(event) => setZoomInput(event.target.value.replace(/[^\d]/g, ''))}
                onBlur={handleZoomInputCommit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleZoomInputCommit();
                  }
                }}
                className="w-[48px] bg-transparent text-right text-sm text-[var(--color-text-primary)] outline-none"
              />
              <span className="text-sm text-[var(--color-text-muted)]">%</span>
            </div>
            <select
              value={zoomSelectValue}
              onChange={handleScaleChange}
              className="appearance-none bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] text-sm px-2 py-1 rounded border border-[var(--color-border)] outline-none cursor-pointer min-w-[70px] text-center"
            >
              {zoomSelectValue === 'custom' && (
                <option value="custom">{currentZoomPercent}%</option>
              )}
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100">100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
              <option value="200">200%</option>
            </select>
            <button
              type="button"
              onClick={zoomIn}
              aria-label="Zoom in"
              className="cursor-pointer rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              title="Zoom in"
            >
              <ZoomIn size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={fitToWidth}
              aria-label="Fit to width"
              className="cursor-pointer rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              title="Fit to width"
            >
              <Maximize2 size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'scroll' ? 'single' : 'scroll')}
              aria-label={viewMode === 'scroll' ? 'Single page mode' : 'Scroll mode'}
              aria-pressed={viewMode === 'single'}
              className={clsx(
                'cursor-pointer rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                viewMode === 'single'
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
              title={viewMode === 'scroll' ? 'Single page mode' : 'Scroll mode'}
            >
              {viewMode === 'scroll' ? (
                <Grid3X3 size={16} aria-hidden="true" />
              ) : (
                <Columns size={16} aria-hidden="true" />
              )}
            </button>
            <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
            <button
              type="button"
              onClick={handleDownload}
              aria-label="Download PDF"
              className="cursor-pointer rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              title="Download PDF"
            >
              <Download size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <AnimatePresence>
            {showThumbnails && (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 140, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] overflow-y-auto flex-shrink-0"
              >
                <div className="p-2 space-y-2">
                  {pageNumbers.map((pageNum) => (
                    <Thumbnail
                      key={pageNum}
                      pageNum={pageNum}
                      isActive={currentPage === pageNum}
                      imageData={thumbnails.get(pageNum) || null}
                      onClick={() => goToPage(pageNum)}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div
            ref={containerRef}
            className="flex-1 overflow-auto"
            style={{ background: 'color-mix(in srgb, var(--color-bg-void) 72%, #4b5563 28%)' }}
          >
            {viewMode === 'scroll' ? (
              <div ref={pagesContainerRef} className="flex flex-col items-center py-4 gap-4">
                {pageNumbers.map((pageNum) => (
                  <div key={pageNum} data-page={pageNum} className="flex justify-center">
                    {visiblePages.has(pageNum) ? (
                      <PDFPage
                        pageNum={pageNum}
                        pdfDoc={pdfDoc}
                        scale={scale}
                        isVisible={true}
                        highlight={
                          activeHighlight && activeHighlight.page === pageNum
                            ? activeHighlight
                            : null
                        }
                        onPageClick={pageClickHandler}
                      />
                    ) : (
                      // Placeholder to prevent layout shift
                      <div
                        className="bg-[var(--color-bg-tertiary)]"
                        style={{
                          width: `${595 * scale}px`,
                          height: `${842 * scale}px`,
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center p-4">
                <PDFPage
                  pageNum={currentPage}
                  pdfDoc={pdfDoc}
                  scale={scale}
                  isVisible={true}
                  highlight={
                    activeHighlight && activeHighlight.page === currentPage ? activeHighlight : null
                  }
                  onPageClick={handlePageClick}
                />
              </div>
            )}
          </div>
        </div>

        {showLogPanel && hasLogs && (
          <CompileLogPanel
            errors={compilationResult?.parsedErrors}
            warnings={compilationResult?.parsedWarnings}
            info={compilationResult?.parsedInfo}
            onClose={() => setShowLogPanel(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-[var(--color-bg-tertiary)] flex items-center justify-center">
          <FileText size={40} className="text-[var(--color-text-disabled)]" />
        </div>
        <p className="text-[var(--color-text-secondary)] font-medium">
          {t('preview.noPdfAvailable')}
        </p>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          {t('preview.compileToPreview')}
        </p>
      </div>
    </div>
  );
};
