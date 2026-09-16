/**
 * @file wordCount.ts - Document word/character counting
 * @description Counts the prose a reader would see, not the markup that
 *   produces it. Journals and supervisors quote word limits against the
 *   rendered text, so `\section{Method}` must contribute "Method" — while
 *   `\label{sec:method}`, math, and the preamble contribute nothing.
 *
 * Pure functions, no service imports, so the counting rules are unit-testable
 * in isolation (see tests/renderer/utils/wordCount.test.ts).
 *
 * Deliberately approximate: a full LaTeX parser would be the only exact
 * answer, and even TeXcount (the de-facto reference) is heuristic. The goal
 * is a number that tracks the real one closely enough to steer drafting.
 */

export interface WordCountResult {
  /** Latin words plus CJK characters — the figure shown to the user. */
  words: number;
  /** Characters of counted prose, whitespace excluded. */
  characters: number;
}

/** Counting strategy per document language. */
export type WordCountMode = 'latex' | 'typst' | 'markdown' | 'plain';

/**
 * Commands whose braced argument is prose and must be counted.
 * Everything else drops its argument (`\label`, `\cite`, `\ref`, `\include`…):
 * dropping is the safer default since an unknown command is far more likely
 * to carry an identifier than a sentence.
 */
const TEXT_ARG_COMMANDS = new Set([
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'chapter',
  'part',
  'title',
  'author',
  'caption',
  'textbf',
  'textit',
  'texttt',
  'textsc',
  'textsf',
  'textrm',
  'emph',
  'underline',
  'text',
  'footnote',
  'item',
]);

/** Environments whose body is not prose. */
const SKIPPED_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'displaymath',
  'eqnarray',
  'eqnarray*',
  'math',
  'verbatim',
  'lstlisting',
  'minted',
  'tikzpicture',
  'tabular',
  'array',
  'thebibliography',
  'filecontents',
  'filecontents*',
]);

/** CJK ideographs, kana and Hangul — counted one character per word. */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/**
 * Strip the LaTeX preamble. Text before `\begin{document}` is setup, not
 * prose; a document without the marker is treated as a fragment (counted
 * whole) so `\input`-style chapter files still report a useful number.
 */
function stripPreamble(source: string): string {
  const marker = source.indexOf('\\begin{document}');
  return marker >= 0 ? source.slice(marker + '\\begin{document}'.length) : source;
}

/** Remove `%` comments, honouring the `\%` escape. */
function stripLatexComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      let out = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '\\' && i + 1 < line.length) {
          out += ch + line[i + 1];
          i += 1;
          continue;
        }
        if (ch === '%') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

/** Drop the body of non-prose environments, including nested content. */
function stripSkippedEnvironments(source: string): string {
  let out = source;
  for (const env of SKIPPED_ENVIRONMENTS) {
    const escaped = env.replace(/[*]/g, '\\*');
    const pattern = new RegExp(`\\\\begin\\{${escaped}\\}[\\s\\S]*?\\\\end\\{${escaped}\\}`, 'g');
    out = out.replace(pattern, ' ');
  }
  return out;
}

/** Remove inline and display math. */
function stripMath(source: string): string {
  return source
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/(?<!\\)\$[^$\n]*?(?<!\\)\$/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ');
}

/**
 * Replace commands with either their prose argument or nothing.
 * `\begin{...}` / `\end{...}` markers are dropped wholesale — surviving
 * environments contribute their body text, not their delimiters.
 */
function stripLatexCommands(source: string): string {
  let out = source.replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?/g, ' ');

  // Repeat so nested markup (`\textbf{\emph{x}}`) unwraps layer by layer.
  // Bounded: each pass strictly shortens the string or stops.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(
      /\\([a-zA-Z@]+)\*?\s*(?:\[[^\]]*\])?\s*(?:\{([^{}]*)\})?/g,
      (_match, name: string, arg: string | undefined) =>
        TEXT_ARG_COMMANDS.has(name) && arg !== undefined ? ` ${arg} ` : ' '
    );
    if (next === out) break;
    out = next;
  }

  // Escaped specials (`\%`, `\&`, `\_`) and leftover braces.
  return out.replace(/\\[^a-zA-Z]/g, ' ').replace(/[{}]/g, ' ');
}

/** Strip Typst markup: comments, code expressions, raw blocks, math. */
function stripTypst(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/^\s*#(?:let|set|show|import|include)[^\n]*/gm, ' ')
    .replace(/#[a-zA-Z][\w-]*(?:\([^)]*\))?/g, ' ')
    .replace(/^[=]+\s+/gm, '');
}

/** Strip Markdown markup that is not read as prose. */
function stripMarkdown(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, ' ');
}

/**
 * Count prose in `source` under the rules for `mode`.
 *
 * CJK text carries no spaces, so ideographs/kana/Hangul are counted per
 * character and removed before the Latin word split — mixed-script documents
 * therefore get `latin words + CJK characters`, which is what both Chinese
 * and English journals expect.
 */
export function countWords(source: string, mode: WordCountMode = 'plain'): WordCountResult {
  if (!source) return { words: 0, characters: 0 };

  let text = source;
  if (mode === 'latex') {
    text = stripLatexCommands(
      stripMath(stripSkippedEnvironments(stripLatexComments(stripPreamble(source))))
    );
  } else if (mode === 'typst') {
    text = stripTypst(source);
  } else if (mode === 'markdown') {
    text = stripMarkdown(source);
  }

  const cjkMatches = text.match(CJK_PATTERN);
  const cjkCount = cjkMatches?.length ?? 0;
  const latinText = text.replace(CJK_PATTERN, ' ');
  const latinWords = latinText.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

  return {
    words: latinWords + cjkCount,
    characters: text.replace(/\s+/g, '').length,
  };
}

/** Map a file path to the counting strategy for its language. */
export function wordCountModeForFile(filePath: string | null | undefined): WordCountMode {
  if (!filePath) return 'plain';
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'tex':
    case 'ltx':
    case 'latex':
    case 'sty':
    case 'cls':
      return 'latex';
    case 'typ':
      return 'typst';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'plain';
  }
}
