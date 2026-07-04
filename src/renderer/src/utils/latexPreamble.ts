/**
 * @file latexPreamble.ts - Shared LaTeX preamble parsing
 * @description Single home for the `\documentclass` / `\usepackage` regexes so
 *              CJK-support detection (services/cjkSupport.ts) and chat-context
 *              intel (services/agent/ChatContextIntelBuilder.ts) don't each keep
 *              their own drifting copy. These are regexes over source text, not
 *              a parser: the first `\documentclass` match wins, which is the real
 *              declaration in virtually all real documents.
 */

/** Matches a whole `\documentclass[opts]{class}` token (no capture). */
export const DOCUMENTCLASS_REGEX = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]+\}/;

/** Same, capturing the class name. */
const DOCUMENTCLASS_CAPTURE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/;

/** Matches `\usepackage[opts]{a,b}` and `\RequirePackage[opts]{a,b}`. */
const USEPACKAGE_REGEX = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** First `\documentclass{...}` match (with `.index`), or null. */
export function matchDocumentClass(src: string): RegExpMatchArray | null {
  return src.match(DOCUMENTCLASS_REGEX);
}

/** Class name from the first `\documentclass{...}`, or null. */
export function extractDocumentClassName(src: string): string | null {
  const m = DOCUMENTCLASS_CAPTURE.exec(src);
  return m ? m[1].trim() : null;
}

/** Flat, de-duplicated list of package names loaded in `src`. */
export function extractPackageNames(src: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Reset lastIndex so successive calls don't skip matches (regex is /g).
  USEPACKAGE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null = USEPACKAGE_REGEX.exec(src);
  while (m !== null) {
    for (const pkg of m[1].split(',')) {
      const name = pkg.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    m = USEPACKAGE_REGEX.exec(src);
  }
  return out;
}
