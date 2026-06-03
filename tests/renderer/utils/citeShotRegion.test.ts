import { describe, expect, it } from 'vitest';

import { bboxToCropRect, pickAbstractRegion } from '../../../shared/utils/citeShotRegion';
import type { MinerUContentList } from '../../../shared/types/zotero-mineru';

describe('pickAbstractRegion', () => {
  it('picks the first body paragraph after an Abstract heading', () => {
    const list: MinerUContentList = [
      { type: 'text', text: 'Paper Title', text_level: 1, bbox: [10, 10, 90, 20], page_idx: 0 },
      { type: 'text', text: 'Abstract', text_level: 2, bbox: [10, 30, 90, 40], page_idx: 0 },
      { type: 'text', text: 'We propose a method.', bbox: [10, 50, 90, 120], page_idx: 0 },
      {
        type: 'text',
        text: '1 Introduction',
        text_level: 2,
        bbox: [10, 130, 90, 140],
        page_idx: 0,
      },
    ];
    expect(pickAbstractRegion(list)).toEqual({ pageIdx: 0, bbox: [10, 50, 90, 120] });
  });

  it('falls back to the first body paragraph when no Abstract heading exists', () => {
    const list: MinerUContentList = [
      { type: 'text', text: 'Title', text_level: 1, bbox: [10, 10, 90, 20], page_idx: 0 },
      { type: 'text', text: 'First body line.', bbox: [10, 30, 90, 60], page_idx: 0 },
    ];
    expect(pickAbstractRegion(list)).toEqual({ pageIdx: 0, bbox: [10, 30, 90, 60] });
  });

  it('returns bbox:null when the target paragraph has no bbox (older MinerU)', () => {
    const list: MinerUContentList = [
      { type: 'text', text: 'Abstract', text_level: 2, page_idx: 2 },
      { type: 'text', text: 'Body without coords.', page_idx: 2 },
    ];
    expect(pickAbstractRegion(list)).toEqual({ pageIdx: 2, bbox: null });
  });

  it('skips non-text and empty items, returns null when no body text exists', () => {
    const list: MinerUContentList = [
      { type: 'image', page_idx: 0 },
      { type: 'text', text: '   ', page_idx: 0 },
      { type: 'table', text: 'col', page_idx: 1 },
    ];
    expect(pickAbstractRegion(list)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickAbstractRegion([])).toBeNull();
  });
});

describe('bboxToCropRect', () => {
  it('scales points to pixels and applies padding', () => {
    // bbox 100..200 x, 50..150 y; scale 2 → 200..400, 100..300; padding 8
    const rect = bboxToCropRect([100, 50, 200, 150], 2, 8, 1000, 1000);
    expect(rect).toEqual({ sx: 192, sy: 92, sw: 216, sh: 216 });
  });

  it('clamps to canvas bounds and never goes negative', () => {
    const rect = bboxToCropRect([0, 0, 600, 400], 1, 8, 500, 500);
    expect(rect.sx).toBe(0);
    expect(rect.sy).toBe(0);
    expect(rect.sw).toBe(500); // right clamped to canvas width
    expect(rect.sh).toBe(408); // 400+8 padding, within 500
  });

  it('normalizes inverted bbox coordinates', () => {
    const rect = bboxToCropRect([200, 150, 100, 50], 1, 0, 1000, 1000);
    expect(rect).toEqual({ sx: 100, sy: 50, sw: 100, sh: 100 });
  });

  it('guarantees at least 1px width/height', () => {
    const rect = bboxToCropRect([10, 10, 10, 10], 1, 0, 1000, 1000);
    expect(rect.sw).toBe(1);
    expect(rect.sh).toBe(1);
  });
});
