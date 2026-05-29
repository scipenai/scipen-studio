/**
 * @file citeShotRegion.ts —— cite hover 截图的纯计算:从 MinerU content_list
 *   选出要截的区域 + 把 bbox 换算成 canvas 裁剪矩形。无副作用,便于单测;
 *   renderer 的 CiteShotService 调用。
 */

import type {
  CiteShotRegion,
  MinerUContentItem,
  MinerUContentList,
} from '../types/zotero-mineru';

const ABSTRACT_HEADING = /^\s*abstract\b/i;

/** 标题项(有 text_level),用来界定 Abstract 段的起点。 */
function isHeading(item: MinerUContentItem): boolean {
  return typeof item.text_level === 'number';
}

/** 正文段:type=text 且非标题。截图取这种段最有信息量。 */
function isBodyText(item: MinerUContentItem): boolean {
  return item.type === 'text' && !isHeading(item) && !!item.text?.trim();
}

function toRegion(item: MinerUContentItem): CiteShotRegion {
  return { pageIdx: item.page_idx, bbox: item.bbox ?? null };
}

/**
 * 选出 hover 要截的区域:优先「Abstract 标题后的第一个正文段」,找不到 Abstract
 * 就退化为「全文第一个正文段」(通常是题头/首段)。整个 list 无正文段 → null
 * (调用方再退化为首页)。目标段无 bbox(旧版本)→ region.bbox=null,渲整页。
 */
export function pickAbstractRegion(list: MinerUContentList): CiteShotRegion | null {
  let sawAbstractHeading = false;
  let firstBody: MinerUContentItem | null = null;

  for (const item of list) {
    if (isHeading(item) && ABSTRACT_HEADING.test(item.text ?? '')) {
      sawAbstractHeading = true;
      continue;
    }
    if (!isBodyText(item)) continue;
    if (sawAbstractHeading) return toRegion(item);
    if (firstBody === null) firstBody = item;
  }

  return firstBody ? toRegion(firstBody) : null;
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 把 PDF points 的 bbox(scale=1)换算成渲染 canvas 上的裁剪矩形:乘 renderScale
 * 转像素,四周加 padding,clamp 到 [0, canvas 尺寸]。padding/clamp 后宽高至少 1px。
 */
export function bboxToCropRect(
  bbox: [number, number, number, number],
  renderScale: number,
  padding: number,
  canvasWidth: number,
  canvasHeight: number
): CropRect {
  const [x0, y0, x1, y1] = bbox;
  const left = Math.max(0, Math.min(x0, x1) * renderScale - padding);
  const top = Math.max(0, Math.min(y0, y1) * renderScale - padding);
  const right = Math.min(canvasWidth, Math.max(x0, x1) * renderScale + padding);
  const bottom = Math.min(canvasHeight, Math.max(y0, y1) * renderScale + padding);
  return {
    sx: left,
    sy: top,
    sw: Math.max(1, right - left),
    sh: Math.max(1, bottom - top),
  };
}
