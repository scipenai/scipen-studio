/**
 * @file CiteShotService — generates a "paper screenshot" for cite hover. Input: itemKey,
 *   output: dataURL. Fallback chain: MinerU bbox → crop abstract region; content_list
 *   without bbox → render that page; no artifacts → render page 1. LRU dedup (papers
 *   belong to the library, reused across hovers), in-flight coalescing of concurrent
 *   requests for the same key, document destroyed after render (not kept in memory).
 */

import type { CiteShotRegion, MinerUContentList } from '../../../../shared/types/zotero-mineru';
import { bboxToCropRect, pickAbstractRegion } from '../../../../shared/utils/citeShotRegion';
import { api } from '../api';
import { createLogger } from './LogService';
import { CMAP_URL, pdfjsLib } from './pdf/pdfjsRuntime';

const logger = createLogger('CiteShotService');

const RENDER_SCALE = 2; // bbox is in scale=1 points; render at 2x then crop, sharp enough
const CROP_PADDING = 8; // padding around crop region (render pixels)
const LRU_MAX = 12; // jpeg ~50–200KB each, 12 entries <~2.5MB
const MAX_PDF_BYTES = 80 * 1024 * 1024; // skip region crop for huge PDFs; render first page instead
const JPEG_QUALITY = 0.85;

export type CiteShotResult =
  | { status: 'ok'; dataUrl: string }
  | { status: 'no-pdf' }
  | { status: 'error' };

const NO_PDF_RESULT: CiteShotResult = { status: 'no-pdf' };
/** Fallback when no content_list / oversized PDF: render full page 1. */
const FIRST_PAGE: CiteShotRegion = { pageIdx: 0, bbox: null };

export class CiteShotService {
  private readonly cache = new Map<string, CiteShotResult>();
  private readonly inFlight = new Map<string, Promise<CiteShotResult>>();

  async getShot(itemKey: string): Promise<CiteShotResult> {
    if (!itemKey) return { status: 'error' };
    const cached = this.cache.get(itemKey);
    if (cached) {
      this.touch(itemKey, cached);
      return cached;
    }
    const existing = this.inFlight.get(itemKey);
    if (existing) return existing;

    const job = this.generate(itemKey).finally(() => this.inFlight.delete(itemKey));
    this.inFlight.set(itemKey, job);
    return job;
  }

  dispose(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async generate(itemKey: string): Promise<CiteShotResult> {
    let result: CiteShotResult;
    try {
      const [contentList, pdfBuf] = await Promise.all([
        api.zotero.getContentList(itemKey).catch(() => null),
        this.loadPdf(itemKey),
      ]);
      result = pdfBuf === 'no-pdf' ? NO_PDF_RESULT : await this.render(pdfBuf, contentList);
    } catch (err) {
      logger.warn('cite shot generation failed', { itemKey, error: String(err) });
      result = { status: 'error' };
    }
    this.store(itemKey, result);
    return result;
  }

  /** Fetch PDF bytes; sentinel for no PDF attachment; other errors propagate (caught by generate as error). */
  private async loadPdf(itemKey: string): Promise<ArrayBuffer | 'no-pdf'> {
    try {
      return await api.zotero.loadPdf(itemKey);
    } catch (err) {
      if (String(err).includes('NO_PDF_ATTACHMENT')) return 'no-pdf';
      throw err;
    }
  }

  /** Huge PDF: skip region crop, render first page. With content_list: pick abstract region. Else first page. */
  private planRegion(pdfBytes: number, contentList: MinerUContentList | null): CiteShotRegion {
    if (pdfBytes > MAX_PDF_BYTES || !contentList || contentList.length === 0) return FIRST_PAGE;
    return pickAbstractRegion(contentList) ?? FIRST_PAGE;
  }

  private async render(
    pdfBuf: ArrayBuffer,
    contentList: MinerUContentList | null
  ): Promise<CiteShotResult> {
    const region = this.planRegion(pdfBuf.byteLength, contentList);
    const doc = await pdfjsLib.getDocument({ data: pdfBuf, cMapUrl: CMAP_URL, cMapPacked: true })
      .promise;
    try {
      const canvas = await this.renderPage(doc, region.pageIdx);
      const dataUrl = region.bbox
        ? cropToDataUrl(canvas, region.bbox)
        : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      return { status: 'ok', dataUrl };
    } finally {
      void doc.destroy();
    }
  }

  private async renderPage(
    doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>,
    pageIdx: number
  ): Promise<HTMLCanvasElement> {
    const page = await doc.getPage(pageIdx + 1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvas;
  }

  /** Cache only deterministic results; errors are not cached to allow retry. Insertion-order LRU; evict oldest when full. */
  private store(itemKey: string, result: CiteShotResult): void {
    if (result.status === 'error') return;
    this.cache.set(itemKey, result);
    while (this.cache.size > LRU_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private touch(itemKey: string, result: CiteShotResult): void {
    this.cache.delete(itemKey);
    this.cache.set(itemKey, result);
  }
}

function cropToDataUrl(source: HTMLCanvasElement, bbox: [number, number, number, number]): string {
  const rect = bboxToCropRect(bbox, RENDER_SCALE, CROP_PADDING, source.width, source.height);
  const out = document.createElement('canvas');
  out.width = rect.sw;
  out.height = rect.sh;
  const ctx = out.getContext('2d');
  if (!ctx) return source.toDataURL('image/jpeg', JPEG_QUALITY);
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  return out.toDataURL('image/jpeg', JPEG_QUALITY);
}

let singleton: CiteShotService | null = null;

export function getCiteShotService(): CiteShotService {
  if (!singleton) singleton = new CiteShotService();
  return singleton;
}
