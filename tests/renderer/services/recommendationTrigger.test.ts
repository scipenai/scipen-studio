import { describe, expect, it } from 'vitest';

import {
  detectParagraphLang,
  extractFromEditor,
  type MinimalModel,
} from '../../../src/renderer/src/services/zotero/recommendationTrigger';
import { formatCitationInsert } from '../../../src/renderer/src/components/editor/citationKeyScan';

function fakeModel(lines: string[], languageId: string): MinimalModel {
  return { getLinesContent: () => lines, getLanguageId: () => languageId };
}

describe('detectParagraphLang', () => {
  it('maps monaco languageIds to DocLang', () => {
    expect(detectParagraphLang('latex')).toBe('latex');
    expect(detectParagraphLang('typst')).toBe('typst');
    expect(detectParagraphLang('markdown')).toBe('markdown');
    expect(detectParagraphLang('plaintext')).toBe('unknown');
  });
});

describe('extractFromEditor', () => {
  it('returns paragraph text + 8-hex hash for a real paragraph', () => {
    const model = fakeModel(
      ['\\section{Intro}', 'Attention mechanisms reshaped sequence modeling profoundly.'],
      'latex'
    );
    const res = extractFromEditor(model, 2);
    expect(res).not.toBeNull();
    expect(res!.text).toContain('Attention mechanisms');
    expect(res!.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns null when the paragraph is too short (<30 chars)', () => {
    const model = fakeModel(['short', '', ''], 'markdown');
    expect(extractFromEditor(model, 1)).toBeNull();
  });

  it('same text yields same hash (guard stability)', () => {
    const model = fakeModel(['a long enough paragraph of meaningful prose here.'], 'unknown');
    expect(extractFromEditor(model, 1)!.hash).toBe(extractFromEditor(model, 1)!.hash);
  });
});

describe('formatCitationInsert', () => {
  it('emits the right cite syntax per language', () => {
    expect(formatCitationInsert('smith2024', 'latex')).toBe('\\cite{smith2024}');
    expect(formatCitationInsert('smith2024', 'typst')).toBe('@smith2024');
    expect(formatCitationInsert('smith2024', 'markdown')).toBe('[@smith2024]');
    expect(formatCitationInsert('smith2024', 'plaintext')).toBe('\\cite{smith2024}');
  });
});
