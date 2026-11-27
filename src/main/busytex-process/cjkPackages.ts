/**
 * @file busytex-process/cjkPackages.ts — CJK TeX package detection for on-demand mounting.
 *
 * Strips unescaped TeX comments before matching document classes or packages so
 * commented-out examples in English papers do not mount the CJK data package.
 */

export const CJK_PACKAGE_URL = 'scipen-wasm://busytex/texlive-cjk.js';

const TEX_SOURCE_EXT = /\.(tex|cls|sty|def|cfg|ltx)$/i;
const CJK_DIRECTIVE_RE =
  /\\(?:documentclass|LoadClass)(?:\s*\[[^\]]*\])?\s*\{ctex[a-z]*\}|\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*\b(?:ctex|ctexcap|ctexsize|ctexheading|xeCJK|xeCJKfntef|CJKfntef|zhnumber)\b/;

/** Strip unescaped `%` comments to end-of-line while preserving literal `\%`. */
function stripTexComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\') {
          i += 1;
          continue;
        }
        if (line[i] === '%') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** Return true when any staged TeX source requests `ctex`, `xeCJK`, or `zhnumber`. */
export function needsCjkPackage(
  files: ReadonlyArray<{ path: string; contents?: string | Uint8Array }>
): boolean {
  for (const file of files) {
    if (!TEX_SOURCE_EXT.test(file.path) || typeof file.contents !== 'string') {
      continue;
    }
    if (CJK_DIRECTIVE_RE.test(stripTexComments(file.contents))) {
      return true;
    }
  }
  return false;
}
