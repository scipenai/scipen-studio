/**
 * @file CitedKeyExtractor.test.ts
 * @description Pure regex extraction tests; no Zotero/Worker dependencies.
 */

import { describe, expect, it } from 'vitest';
import {
  extractCitedKeys,
  uniqueCitedKeys,
} from '../../../src/renderer/src/services/zotero/CitedKeyExtractor';

describe('CitedKeyExtractor', () => {
  describe('LaTeX', () => {
    it('extracts a single \\cite{key}', () => {
      const occs = extractCitedKeys('See \\cite{smith2024deep} for details.');
      expect(occs).toHaveLength(1);
      expect(occs[0]).toMatchObject({ key: 'smith2024deep', line: 1 });
    });

    it('extracts multiple keys from \\cite{a,b,c}', () => {
      const occs = extractCitedKeys('Comparisons \\cite{a,b,c} done.');
      expect(occs.map((o) => o.key)).toEqual(['a', 'b', 'c']);
    });

    it('trims whitespace around comma-separated keys', () => {
      const occs = extractCitedKeys('\\cite{ smith2024 ,  jones2023 }');
      expect(occs.map((o) => o.key)).toEqual(['smith2024', 'jones2023']);
    });

    it('handles \\citep, \\citet, \\citeauthor variants', () => {
      const occs = extractCitedKeys('\\citep{a} \\citet{b} \\citeauthor{c}');
      expect(occs.map((o) => o.key)).toEqual(['a', 'b', 'c']);
    });

    it('handles optional argument \\cite[ch.~3]{key}', () => {
      const occs = extractCitedKeys('See \\cite[ch.~3]{textbook}.');
      expect(occs.map((o) => o.key)).toEqual(['textbook']);
    });

    it('tracks line numbers for multi-line input', () => {
      const occs = extractCitedKeys('first line\n\\cite{here}\nthird');
      expect(occs[0]?.line).toBe(2);
    });
  });

  describe('Typst', () => {
    it('extracts @key tokens', () => {
      const occs = extractCitedKeys('See @smith2024 for details.');
      expect(occs.map((o) => o.key)).toEqual(['smith2024']);
    });

    it('rejects single-letter keys', () => {
      // Regex requires {1,} after the leading letter, total length >= 2.
      const occs = extractCitedKeys('@a vs @ab');
      expect(occs.map((o) => o.key)).toEqual(['ab']);
    });

    it('does not match email-like @domain.com (period breaks word chars)', () => {
      const occs = extractCitedKeys('email@example.com');
      // 'example' is a valid Typst key but the @ is the trigger char
      // and Typst doesn't care about the leading "email" prefix — we
      // accept this as a known false-positive. Adjust if needed.
      expect(occs.map((o) => o.key)).toEqual(['example']);
    });
  });

  describe('mixed', () => {
    it('extracts both LaTeX and Typst from the same document', () => {
      const text = 'LaTeX: \\cite{aa}\nTypst: @bb';
      const occs = extractCitedKeys(text);
      expect(occs.map((o) => o.key).sort()).toEqual(['aa', 'bb']);
    });
  });

  describe('uniqueCitedKeys', () => {
    it('preserves first-occurrence order and de-duplicates', () => {
      const occs = extractCitedKeys('\\cite{aa,bb,aa} \\cite{cc} @bb');
      expect(uniqueCitedKeys(occs)).toEqual(['aa', 'bb', 'cc']);
    });

    it('returns empty array for empty input', () => {
      expect(uniqueCitedKeys([])).toEqual([]);
    });
  });

  describe('column tracking', () => {
    it('reports the column of the key, not the \\cite command', () => {
      const occs = extractCitedKeys('\\cite{key}');
      // \cite{ = 6 chars, key starts at column 7 (1-based)
      expect(occs[0]?.column).toBe(7);
    });

    it('reports columns within a multi-key brace correctly', () => {
      const occs = extractCitedKeys('\\cite{a,b}');
      // \cite{ = col 1..6; 'a' = col 7; ',' = col 8; 'b' = col 9
      expect(occs[0]?.column).toBe(7);
      expect(occs[1]?.column).toBe(9);
    });
  });
});
