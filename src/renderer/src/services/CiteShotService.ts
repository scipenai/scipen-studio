/**
 * @file CiteShotService —— 给 cite hover 生成「论文截图」。输入 itemKey,输出
 *   dataURL。降级链:精解析有 bbox → 裁摘要区;有 content_list 无 bbox → 渲该页;
 *   无产物 → 渲第 1 页。LRU 去重(论文属文献库,跨 hover 复用),in-flight 合并
 *   同 key 并发,渲完即 destroy 文档不驻留内存。
 */

import type { CiteShotRegion, MinerUContentList } from '../../../../shared/types/zotero-mineru';
import { bboxToCropRect, pickAbstractRegion } from '../../../../shared/utils/citeShotRegion';
import { api } from '../api';
import { createLogger } from './LogService';
import { CMAP_URL, pdfjsLib } from './pdf/pdfjsRuntime';

const logger = createLogger('CiteShotService');

const RENDER_SCALE = 2; // bbox 是 scale=1 的 points,渲染放大 2 倍再裁,清晰度够用
const CROP_PADDING = 8; // 裁剪区四周留白(渲染像素)
const LRU_MAX = 12; // jpeg 单张 50–200KB,12 张 <~2.5MB
const MAX_PDF_BYTES = 80 * 1024 * 1024; // 超大 PDF 跳过区域裁剪,直接渲首页
const JPEG_QUALITY = 0.85;

export type CiteShotResult =
  | { status: 'ok'; dataUrl: string }
  | { status: 'no-pdf' }
  | { status: 'error' };

const NO_PDF_RESULT: CiteShotResult = { status: 'no-pdf' };
/** 无 content_list / 超大 PDF 时的兜底:渲第 1 页整页。 */
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

  /** 拉 PDF 字节;无 PDF 附件返回哨兵,其它错误抛出(由 generate 兜成 error)。 */
  private async loadPdf(itemKey: string): Promise<ArrayBuffer | 'no-pdf'> {
    try {
      return await api.zotero.loadPdf(itemKey);
    } catch (err) {
      if (String(err).includes('NO_PDF_ATTACHMENT')) return 'no-pdf';
      throw err;
    }
  }

  /** 超大 PDF 跳过区域裁剪渲首页;有 content_list 选摘要区;否则渲首页。 */
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

  /** 只缓存确定性结果;error 不缓存以允许重试。插入序 LRU,超限删最久未访问。 */
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
