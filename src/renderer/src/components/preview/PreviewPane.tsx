/**
 * @file PreviewPane.tsx - PDF Preview Panel
 * @description Real-time PDF preview component with zoom, pagination, SyncTeX bidirectional sync
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Columns,
  Download,
  FileText,
  Grid3X3,
  Maximize2,
  ScrollText,
  Sidebar,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import {
  TaskPriority,
  cancelIdleTask,
  scheduleIdleTask,
} from '../../services/core/IdleTaskScheduler';
import {
  getProjectService,
  getSettingsService,
  getUIService,
} from '../../services/core/ServiceRegistry';
import {
  useCompilationResult,
  useIsCompiling,
  usePdfData,
  usePdfHighlight,
} from '../../services/core/hooks';
import { DOMScheduler, SchedulePriority } from '../../utils/DOMScheduler';
import { useTranslation } from '../../locales';
import { CompileLogPanel } from './CompileLogPanel';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
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
  onRendered?: () => void;
  onPageClick?: (pageNum: number, x: number, y: number) => void;
}>(({ pageNum, pdfDoc, scale, isVisible, onRendered, onPageClick }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendered, setIsRendered] = useState(false);
  const renderingRef = useRef(false);

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

        // PDF.js type definitions incomplete: render() requires canvas property but type doesn't declare it
        await (
          page.render({
            canvasContext: context,
            viewport: viewport,
            canvas: canvas,
          }) as { promise: Promise<void> }
        ).promise;

        setIsRendered(true);
        onRendered?.();
      } catch (error) {
        console.error(`Failed to render page ${pageNum}:`, error);
      } finally {
        renderingRef.current = false;
      }
    };

    renderPage();
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
    </div>
  );
});
PDFPage.displayName = 'PDFPage';

export const PreviewPane: React.FC = () => {
  const pdfData = usePdfData();
  const isCompiling = useIsCompiling();
  const compilationResult = useCompilationResult();
  const pdfHighlight = usePdfHighlight();
  const uiService = getUIService();
  const { t } = useTranslation();

  const [scale, setScale] = useState(1.2);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const [viewMode, setViewMode] = useState<'scroll' | 'single'>('scroll');
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1, 2, 3]));
  const [showLogPanel, setShowLogPanel] = useState(false);

  // Thumbnail generation task version token for canceling stale tasks
  const thumbnailGenerationTokenRef = useRef(0);

  const hasLogs =
    compilationResult &&
    ((compilationResult.parsedErrors?.length ?? 0) > 0 ||
      (compilationResult.parsedWarnings?.length ?? 0) > 0 ||
      (compilationResult.parsedInfo?.length ?? 0) > 0);

  // Auto-show log panel on compilation failure to surface errors immediately
  useEffect(() => {
    if (compilationResult && !compilationResult.success && hasLogs) {
      setShowLogPanel(true);
    }
  }, [compilationResult, hasLogs]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

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

      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);
      setVisiblePages(new Set([1, 2, 3]));
      setThumbnails(new Map());

      // Generate thumbnails asynchronously to avoid blocking main rendering
      // Use unified scheduler to prevent multiple concurrent tasks when switching back
      cancelIdleTask(THUMBNAIL_TASK_ID);
      thumbnailGenerationTokenRef.current += 1;
      const generationToken = thumbnailGenerationTokenRef.current;

      scheduleIdleTask(() => generateThumbnails(doc, generationToken), {
        id: THUMBNAIL_TASK_ID,
        priority: TaskPriority.Low,
        timeout: 3000,
      });
    } catch (error) {
      console.error('Failed to load PDF:', error);
    } finally {
      setIsInitialLoading(false);
    }
  };

  // Clean up thumbnail task on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cancelIdleTask(THUMBNAIL_TASK_ID);
      // Invalidate token so running tasks exit automatically
      thumbnailGenerationTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
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
  }, [pdfHighlight, pdfDoc, totalPages, uiService]);

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

  const generateThumbnails = useCallback(
    async (doc: pdfjsLib.PDFDocumentProxy, generationToken: number) => {
      // Exit if task is stale
      if (generationToken !== thumbnailGenerationTokenRef.current) {
        return;
      }
      const thumbMap = new Map<number, string>();

      for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
        // Stop generation if task is stale
        if (generationToken !== thumbnailGenerationTokenRef.current) {
          return;
        }
        try {
          const page = await doc.getPage(i);
          // Stop generation if task is stale
          if (generationToken !== thumbnailGenerationTokenRef.current) {
            return;
          }
          const viewport = page.getViewport({ scale: 0.15 });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          const context = canvas.getContext('2d');
          if (context) {
            // PDF.js type definitions incomplete: render() requires canvas property but type doesn't declare it
            await (
              page.render({
                canvasContext: context,
                viewport: viewport,
                canvas: canvas,
              }) as { promise: Promise<void> }
            ).promise;

            thumbMap.set(i, canvas.toDataURL('image/jpeg', 0.6));
          }

          // Update state after each thumbnail to show progress incrementally
          setThumbnails(new Map(thumbMap));

          // Yield to main thread to prevent blocking
          await new Promise((r) => setTimeout(r, 10));
        } catch (e) {
          console.error(`Failed to generate thumbnail for page ${i}:`, e);
        }
      }
    },
    []
  );

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
      const containerWidth = containerRef.current!.clientWidth - (showThumbnails ? 180 : 48);
      const viewport = page.getViewport({ scale: 1 });
      const newScale = containerWidth / viewport.width;
      setScale(Math.min(Math.max(newScale, 0.5), 3));
    });
  }, [pdfDoc, showThumbnails]);

  const handleDownload = useCallback(() => {
    if (pdfBytes) {
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'document.pdf';
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [pdfBytes]);

  const zoomIn = useCallback(() => setScale((s) => Math.min(3, s + 0.1)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(0.5, s - 0.1)), []);
  const handleScaleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setScale(Number(e.target.value) / 100);
  }, []);

  // PDF page click handler (SyncTeX reverse sync: navigate from PDF to source code)
  const handlePageClick = useCallback(async (pageNum: number, x: number, y: number) => {
    const uiService = getUIService();
    const projectService = getProjectService();
    const settingsService = getSettingsService();
    const projectPath = projectService.projectPath;

    const isRemote = projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');

    if (isRemote) {
      // Remote projects use Overleaf's SyncTeX API
      const remoteBuildId = uiService.remoteBuildId;
      if (!remoteBuildId) {
        uiService.addCompilationLog({
          type: 'warning',
          message: 'SyncTeX: Please compile the document first',
        });
        return;
      }

      const projectId = settingsService.compiler.overleaf?.projectId;
      if (!projectId) {
        uiService.addCompilationLog({ type: 'warning', message: 'SyncTeX: Missing project ID' });
        return;
      }

      try {
        const result = await api.overleaf.syncPdf(projectId, pageNum, x, y, remoteBuildId);
        if (result?.file && result.line !== undefined) {
          const fullPath = `overleaf://${projectId}/${result.file}`;
          window.dispatchEvent(
            new CustomEvent('synctex-goto-line', {
              detail: {
                file: fullPath,
                line: result.line,
                column: result.column || 1,
              },
            })
          );
        } else {
          uiService.addCompilationLog({
            type: 'warning',
            message: 'SyncTeX: Corresponding location not found',
          });
        }
      } catch (error) {
        console.error('SyncTeX backward failed:', error);
      }
    } else {
      // Local projects use local synctex command
      const synctexPath = uiService.synctexPath;

      if (!synctexPath) {
        uiService.addCompilationLog({
          type: 'warning',
          message: 'SyncTeX: Please compile the document first',
        });
        return;
      }

      try {
        const result = await api.synctex.backward(synctexPath, pageNum, x, y);
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
    }
  }, []);

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

  if (pdfDoc && totalPages > 0) {
    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
        <div className="flex items-center justify-between px-2 py-1.5 bg-[var(--color-bg-primary)] border-b border-[var(--color-border)]">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowThumbnails(!showThumbnails)}
              className={clsx(
                'p-1.5 rounded transition-colors',
                showThumbnails
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
              title="Show thumbnails"
            >
              <Sidebar size={16} />
            </button>
            <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
            <span className="text-sm text-[var(--color-text-secondary)] min-w-[60px] text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="p-1 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
              title="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="p-1 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
              title="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={zoomOut}
              className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <select
              value={Math.round(scale * 100)}
              onChange={handleScaleChange}
              className="appearance-none bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] text-sm px-2 py-1 rounded border border-[var(--color-border)] outline-none cursor-pointer min-w-[70px] text-center"
            >
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100">100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
              <option value="200">200%</option>
            </select>
            <button
              onClick={zoomIn}
              className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
            <button
              onClick={fitToWidth}
              className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Fit to width"
            >
              <Maximize2 size={16} />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setViewMode(viewMode === 'scroll' ? 'single' : 'scroll')}
              className={clsx(
                'p-1.5 rounded transition-colors',
                viewMode === 'single'
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
              title={viewMode === 'scroll' ? 'Single page mode' : 'Scroll mode'}
            >
              {viewMode === 'scroll' ? <Grid3X3 size={16} /> : <Columns size={16} />}
            </button>
            <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
            <button
              onClick={handleDownload}
              className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Download PDF"
            >
              <Download size={16} />
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

          <div ref={containerRef} className="flex-1 overflow-auto bg-[#525659]">
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
                        onPageClick={handlePageClick}
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

        {compilationResult?.success && (
          <div className="px-3 py-1.5 bg-[var(--color-bg-primary)] border-t border-[var(--color-border)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-[var(--color-success)]">
              <CheckCircle size={14} />
              <span>{t('editor.compilationSuccess')}</span>
              {hasLogs && (
                <button
                  onClick={() => setShowLogPanel(!showLogPanel)}
                  className={clsx(
                    'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ml-2',
                    showLogPanel
                      ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                      : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                  )}
                >
                  <ScrollText size={12} />
                  <span>{t('compileLog.log')}</span>
                  {(compilationResult?.parsedErrors?.length ?? 0) > 0 && (
                    <span className="text-[var(--color-error)]">
                      ({compilationResult?.parsedErrors?.length})
                    </span>
                  )}
                  {(compilationResult?.parsedWarnings?.length ?? 0) > 0 && (
                    <span className="text-[var(--color-warning)]">
                      ({compilationResult?.parsedWarnings?.length})
                    </span>
                  )}
                </button>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
              {compilationResult.time && (
                <span>Time: {(compilationResult.time / 1000).toFixed(2)}s</span>
              )}
              <span>{totalPages} pages</span>
            </div>
          </div>
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
