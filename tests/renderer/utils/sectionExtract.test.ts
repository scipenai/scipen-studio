import { describe, expect, it } from 'vitest';

import {
  detectDocLang,
  extractParagraphContext,
  hashParagraph,
} from '../../../shared/utils/sectionExtract';

describe('detectDocLang', () => {
  it('maps extensions and languageIds', () => {
    expect(detectDocLang('main.tex')).toBe('latex');
    expect(detectDocLang('latex')).toBe('latex');
    expect(detectDocLang('paper.typ')).toBe('typst');
    expect(detectDocLang('typst')).toBe('typst');
    expect(detectDocLang('README.md')).toBe('markdown');
    expect(detectDocLang('notes.markdown')).toBe('markdown');
    expect(detectDocLang('data.json')).toBe('unknown');
  });
});

describe('extractParagraphContext', () => {
  const latex = [
    '\\section{Intro}', // 1
    'Attention mechanisms transform sequence modeling deeply.', // 2
    'They allow long-range dependency capture across tokens.', // 3
    '', // 4 (blank)
    '\\section{Method}', // 5
    'We propose a new gated recurrent variant for speed.', // 6
  ];

  it('captures the paragraph the cursor sits in, stopping at blank line and heading', () => {
    const ctx = extractParagraphContext(latex, 3, 'latex');
    expect(ctx.startLine).toBe(2); // heading line 1 not included (stops at it as upper bound)
    expect(ctx.endLine).toBe(3);
    expect(ctx.text).toContain('Attention mechanisms');
    expect(ctx.text).toContain('long-range');
    expect(ctx.text).not.toContain('gated recurrent');
  });

  it('includes the heading line when cursor is on it', () => {
    const ctx = extractParagraphContext(latex, 5, 'latex');
    expect(ctx.text).toContain('\\section{Method}');
    expect(ctx.text).toContain('gated recurrent');
  });

  it('markdown headings act as boundaries', () => {
    const md = ['# Title', 'first body paragraph here is reasonably long.', '## Next', 'other'];
    const ctx = extractParagraphContext(md, 2, 'markdown');
    expect(ctx.text).toContain('first body paragraph');
    expect(ctx.text).not.toContain('Next');
  });

  it('typst headings act as boundaries', () => {
    const typ = ['= Section', 'typst body content that is sufficiently long to keep.', '== Sub'];
    const ctx = extractParagraphContext(typ, 2, 'typst');
    expect(ctx.text).toContain('typst body content');
  });

  it('strips leading comments', () => {
    const src = ['% a latex comment line that should be dropped entirely here', 'real content stays in output text.'];
    const ctx = extractParagraphContext(src, 2, 'latex');
    expect(ctx.text).toBe('real content stays in output text.');
  });

  it('falls back to ±radius lines when cursor is on a blank/short paragraph', () => {
    const sparse = ['lorem ipsum dolor sit amet line one here', '', '', 'tail content far below the cursor position.'];
    const ctx = extractParagraphContext(sparse, 2, 'unknown');
    // line 2 is blank → paragraph too short → fallback widens
    expect(ctx.text.length).toBeGreaterThanOrEqual(30);
  });

  it('clamps to maxChars with ellipsis', () => {
    const long = ['x'.repeat(500)];
    const ctx = extractParagraphContext(long, 1, 'unknown', 100);
    expect(ctx.text.endsWith(' …')).toBe(true);
    expect(ctx.text.length).toBeLessThanOrEqual(103);
  });

  it('handles empty input', () => {
    expect(extractParagraphContext([], 1, 'latex')).toEqual({ text: '', startLine: 0, endLine: 0 });
  });

  it('clamps out-of-range cursor', () => {
    const ctx = extractParagraphContext(latex, 999, 'latex');
    expect(ctx.endLine).toBeLessThanOrEqual(latex.length);
  });
});

describe('hashParagraph', () => {
  it('is stable for identical input', () => {
    expect(hashParagraph('hello world')).toBe(hashParagraph('hello world'));
  });

  it('differs for different input', () => {
    expect(hashParagraph('a')).not.toBe(hashParagraph('b'));
  });

  it('returns 8 hex chars', () => {
    expect(hashParagraph('anything')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles empty string', () => {
    expect(hashParagraph('')).toMatch(/^[0-9a-f]{8}$/);
  });
});
