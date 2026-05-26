/**
 * @file CitedKeyExtractor — pulls every citation key used in a file
 *
 * Used by `ProjectCitedReferencesPanel` (PM-5: "current paper" mini-
 * panel that lists only the references actually cited in this file) and
 * shared with `CiteHoverProvider`'s key-shape regex so the two never
 * disagree about what counts as a citation.
 *
 * Two grammars: LaTeX `\cite{a,b,c}` family and Typst `@key`. We
 * deliberately tolerate Markdown source with embedded `\cite{}` (common
 * in pandoc workflows) by reusing the LaTeX regex on any language.
 */

export interface CitedKeyOccurrence {
  /** Citation key (BBT or Zotero itemKey form — extractor is agnostic). */
  key: string;
  /** 1-based line number for editor jumps. */
  line: number;
  /** 1-based column where the key starts. */
  column: number;
}

const LATEX_CITE_REGEX = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const TYPST_CITE_REGEX = /@([A-Za-z][\w-]{1,})/g;

/**
 * Scan `text` and yield every citation key occurrence in document order.
 * Duplicates are preserved so the panel can show "cited 3x"-style
 * counts; callers that want unique keys should de-duplicate themselves.
 */
export function extractCitedKeys(text: string): CitedKeyOccurrence[] {
  const out: CitedKeyOccurrence[] = [];
  const lines = text.split(/\r?\n/);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    extractLatexOnLine(line, li + 1, out);
    extractTypstOnLine(line, li + 1, out);
  }
  return out;
}

function extractLatexOnLine(line: string, lineNo: number, out: CitedKeyOccurrence[]): void {
  LATEX_CITE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LATEX_CITE_REGEX.exec(line)) !== null) {
    const inside = m[1];
    const braceStart = m.index + m[0].indexOf('{') + 1;
    let cursor = 0;
    for (const part of inside.split(',')) {
      const trimmed = part.trim();
      if (trimmed) {
        const leading = part.length - part.trimStart().length;
        out.push({
          key: trimmed,
          line: lineNo,
          column: braceStart + cursor + leading + 1,
        });
      }
      cursor += part.length + 1; // +1 for the comma
    }
  }
}

function extractTypstOnLine(line: string, lineNo: number, out: CitedKeyOccurrence[]): void {
  TYPST_CITE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPST_CITE_REGEX.exec(line)) !== null) {
    out.push({ key: m[1], line: lineNo, column: m.index + 1 });
  }
}

/**
 * Convenience: collapse occurrences to a unique key list, preserving
 * first-appearance order.
 */
export function uniqueCitedKeys(occurrences: CitedKeyOccurrence[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const occ of occurrences) {
    if (!seen.has(occ.key)) {
      seen.add(occ.key);
      out.push(occ.key);
    }
  }
  return out;
}
