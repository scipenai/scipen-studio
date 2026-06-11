/**
 * @file citationKeyScan — locate the citation key under the cursor (single-line scan).
 *   Shared by hover preview (CitePreviewService) and Ctrl+Click jump (editorSetup) so
 *   that "what counts as a citation" has zero semantic drift. The key-extraction regex
 *   matches `CitedKeyExtractor`.
 */

import type * as monaco from 'monaco-editor';

const LATEX_CITE_REGEX = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const TYPST_CITE_REGEX = /@([A-Za-z][\w-]{1,})/g;

/**
 * Locate the citation key under the cursor — scans only the current line to avoid
 * re-running a full-document regex on every hover.
 * Supports both LaTeX `\cite{}` and Typst `@key`; Markdown takes the LaTeX path
 * (pandoc-style `[@key]` is also captured by the Typst regex, so the UX is seamless).
 */
export function findCitationKeyAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  // Typed as `string` (not a union) to accept `model.getLanguageId()`; only 'typst' is special-cased.
  languageId: string
): string | null {
  const line = model.getLineContent(position.lineNumber);
  const col = position.column - 1;

  if (languageId === 'typst') {
    return scanLine(line, col, TYPST_CITE_REGEX, (m) => m[1]);
  }
  const latexHit = scanLine(line, col, LATEX_CITE_REGEX, (m) => extractKeyAt(m, col));
  if (latexHit) return latexHit;
  return scanLine(line, col, TYPST_CITE_REGEX, (m) => m[1]);
}

function scanLine(
  line: string,
  col: number,
  regex: RegExp,
  pick: (m: RegExpExecArray) => string | null
): string | null {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (col >= match.index && col <= match.index + match[0].length) {
      const picked = pick(match);
      if (picked) return picked.trim();
    }
  }
  return null;
}

/**
 * Given a `\cite{a,b,c}` match plus the cursor column, return the specific key under
 * the cursor (so hover follows the cursor on multi-key citations). Returns null when
 * the cursor is on the command itself (outside the braces).
 */
export function extractKeyAt(match: RegExpExecArray, col: number): string | null {
  const matchStart = match.index;
  const matchText = match[0];
  const braceStart = matchStart + matchText.indexOf('{') + 1;
  const braceEnd = matchStart + matchText.lastIndexOf('}');
  if (col < braceStart || col > braceEnd) return null;
  const inside = match[1];
  let cursor = 0;
  for (const part of inside.split(',')) {
    const start = cursor;
    const end = cursor + part.length;
    if (col - braceStart >= start && col - braceStart <= end) {
      return part.trim();
    }
    cursor = end + 1;
  }
  return null;
}

/**
 * Reverse direction: given a citation key + language, return the citation text to
 * insert into the editor. Shares regex semantics with the scanner above (so "what
 * counts as a cite" has zero drift): latex `\cite{}` / typst `@key` /
 * markdown pandoc `[@key]`. Unknown languages fall back to latex `\cite{}` (most
 * generally compatible).
 */
export function formatCitationInsert(citationKey: string, languageId: string): string {
  if (languageId === 'typst') return `@${citationKey}`;
  if (languageId === 'markdown') return `[@${citationKey}]`;
  return `\\cite{${citationKey}}`;
}

/** Exported for tests. */
export const _internal = { findCitationKeyAt, extractKeyAt, formatCitationInsert };
