/**
 * @file ChatContextIntelBuilder — composes the `project_intel` markdown blob.
 *
 * The blob is a free-form summary the LLM reads verbatim. P1 gathers
 * cheap, single-file (active tab) signals plus a compile summary:
 *
 *   - documentclass + packages (\documentclass / \usepackage)
 *   - custom macros (\newcommand / \renewcommand / \DeclareMathOperator)
 *   - current section path (\section / \subsection / \subsubsection
 *     stack walked from top to cursor line)
 *   - content window: ±N lines around the cursor
 *   - last compile summary (engine, success, error/warning count)
 *
 * Cross-file intel (labels / citations / bibliography / include graph) is
 * intentionally deferred to a follow-up — those need a project-wide scan
 * and benefit from caching.
 *
 * Output is hard-capped (~4 KB) so a verbose document can't blow the prompt.
 */

import type { AppSettings } from '../../types';

const MAX_OUTPUT_BYTES = 4096;
const CONTENT_WINDOW_LINES = 20;
const MAX_PACKAGES = 32;
const MAX_MACROS = 32;

export interface IntelInputs {
  activeFilePath: string;
  activeFileContent: string;
  cursorLine: number; // 0-based
  language: string; // 'latex' | 'typst' | …
  settings: Pick<AppSettings, 'compiler'>;
  lastCompile: {
    success: boolean;
    engine?: string;
    errorCount: number;
    warningCount: number;
    durationMs?: number;
  } | null;
}

export function buildProjectIntel(input: IntelInputs): string | undefined {
  // Only LaTeX-flavoured intel is implemented in P1. For other languages
  // we'd need different extractors; emit nothing instead of half-truths.
  if (input.language !== 'latex' && !input.activeFilePath.toLowerCase().endsWith('.tex')) {
    return undefined;
  }

  const sections: string[] = [];

  const docClass = extractDocumentClass(input.activeFileContent);
  const packages = extractPackages(input.activeFileContent);
  const macros = extractMacros(input.activeFileContent);
  if (docClass || packages.length > 0 || macros.length > 0) {
    const lines = ['## Document'];
    if (docClass) lines.push(`- documentclass: \`${docClass}\``);
    if (packages.length > 0) {
      lines.push(`- packages (${packages.length}): ${packages.slice(0, MAX_PACKAGES).join(', ')}`);
    }
    if (macros.length > 0) {
      lines.push(`- custom macros (${macros.length}): ${macros.slice(0, MAX_MACROS).join(', ')}`);
    }
    sections.push(lines.join('\n'));
  }

  const sectionPath = extractCurrentSection(input.activeFileContent, input.cursorLine);
  if (sectionPath.length > 0) {
    sections.push(`## Current section\n${sectionPath.join(' > ')}`);
  }

  const window = extractContentWindow(input.activeFileContent, input.cursorLine);
  if (window) {
    sections.push(
      `## Content window (±${CONTENT_WINDOW_LINES} lines)\n\`\`\`latex\n${window}\n\`\`\``
    );
  }

  if (input.lastCompile) {
    const lc = input.lastCompile;
    const status = lc.success ? '✓ success' : '✗ failed';
    const engine = lc.engine ?? input.settings.compiler.engine;
    const duration = lc.durationMs ? ` in ${(lc.durationMs / 1000).toFixed(1)}s` : '';
    sections.push(
      `## Last compile\n- ${status} (engine: ${engine})${duration}\n- ${lc.errorCount} error(s), ${lc.warningCount} warning(s)`
    );
  }

  if (sections.length === 0) return undefined;

  const joined = sections.join('\n\n');
  return capByBytes(joined, MAX_OUTPUT_BYTES);
}

// ============ Extractors ============

/** `\documentclass[options]{class}` → "class" (options stripped for brevity). */
function extractDocumentClass(src: string): string | null {
  const m = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/.exec(src);
  return m ? m[1].trim() : null;
}

/** `\usepackage[opts]{name1,name2}` → flat list of package names. */
function extractPackages(src: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    for (const pkg of m[1].split(',')) {
      const name = pkg.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** `\newcommand{\foo}{…}` / `\renewcommand{\foo}{…}` / `\DeclareMathOperator{\foo}{…}`. */
function extractMacros(src: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\\(?:re)?newcommand\*?\{\\([A-Za-z@]+)\}|\\DeclareMathOperator\*?\{\\([A-Za-z@]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = `\\${m[1] ?? m[2]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Walk `\part / \chapter / \section / \subsection / \subsubsection / \paragraph`
 * from line 0 up to (not including) cursorLine, tracking the deepest path.
 * Returns shallowest-first.
 */
function extractCurrentSection(src: string, cursorLine: number): string[] {
  const lines = src.split('\n');
  const limit = Math.min(cursorLine, lines.length);
  const levelByCmd: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
    paragraph: 5,
    subparagraph: 6,
  };
  const stack: Array<{ level: number; title: string }> = [];
  const re =
    /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]*)\}/;
  for (let i = 0; i < limit; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const level = levelByCmd[m[1]];
    const title = m[2].trim();
    // Pop deeper-or-same levels — we're entering a sibling/parent.
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
  }
  return stack.map((s) => s.title);
}

function extractContentWindow(src: string, cursorLine: number): string | null {
  if (!src) return null;
  const lines = src.split('\n');
  const safeCursor = Math.max(0, Math.min(cursorLine, lines.length - 1));
  const from = Math.max(0, safeCursor - CONTENT_WINDOW_LINES);
  const to = Math.min(lines.length, safeCursor + CONTENT_WINDOW_LINES + 1);
  if (to <= from) return null;
  return lines
    .slice(from, to)
    .map((ln, idx) => {
      const lineNo = from + idx;
      const marker = lineNo === safeCursor ? '►' : ' ';
      return `${String(lineNo + 1).padStart(4)} ${marker} ${ln}`;
    })
    .join('\n');
}

function capByBytes(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  // Binary-search a char count that fits — UTF-8 makes a flat truncate risky
  // for non-ASCII content (we may slice through a multi-byte sequence).
  const reserve = 16; // room for the "(truncated)" tail
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (encoder.encode(s.slice(0, mid)).length <= maxBytes - reserve) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${s.slice(0, lo)}\n… (truncated)`;
}
