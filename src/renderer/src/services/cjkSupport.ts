/**
 * @file cjkSupport.ts - Chinese/CJK authoring helpers
 * @description Pure, side-effect-free helpers for detecting Chinese content in
 *              a LaTeX source and offering the user a *visible, on-disk* way to
 *              add standard CJK support.
 *
 *              Design principle (see plan `breezy-dreaming-eclipse.md`): scipen
 *              does NOT inject any private package (no `scipencjk`), does NOT
 *              mount bundled fonts, and does NOT mutate the source behind the
 *              user's back. A document that renders Chinese in scipen must do so
 *              with standard, portable LaTeX (`\usepackage{ctex}`) that compiles
 *              identically on Overleaf, a local TeX Live, or any other tool.
 *
 *              These helpers only power a one-click "add Chinese support" action
 *              (which edits the real source) — the actual CJK packages/fonts are
 *              resolved by the compiler from the TeX Live tree, exactly like a
 *              native install. This mirrors TeXlyre, which special-cases nothing.
 */

import { extractPackageNames, matchDocumentClass } from '../utils/latexPreamble';

/**
 * Regex catching any CJK Unified Ideograph (BMP block U+4E00-U+9FFF +
 * Extension A U+3400-U+4DBF). Covers the overwhelming majority of Han
 * characters in real documents. We don't include CJK symbols/punctuation
 * or kana — those frequently coexist with pure Latin docs (e.g. a citation
 * containing a Japanese title) and aren't a reliable signal that the body
 * needs a CJK package loaded.
 *
 * `\u`-escaped (not literal glyphs) so this file stays single-language for
 * grep/blame and clears `npm run lint:no-cjk` without an allow-cjk marker.
 */
const CJK_HAN_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * Classes/packages that already configure CJK rendering. If the user wrote any
 * of these, the document is "driving" its own CJK setup and we must not offer to
 * add another package. Match is case-sensitive (LaTeX macros are).
 */
const CTEX_DOCUMENTCLASS_REGEX = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{ctex[a-z]*\}/;
const USER_CJK_PACKAGE_NAMES = new Set([
  'ctex',
  'xeCJK',
  'xeCJKfntef',
  'CJK',
  'CJKutf8',
  'luatexja',
  'luatexja-fontspec',
]);

/**
 * The standard, portable package we add. `fontset=fandol` pins a font set
 * that ships with every TeX Live (Fandol), so the compiled result is
 * deterministic across platforms; a bare `\usepackage{ctex}` also works
 * (ctex auto-detects a fontset), but explicit is friendlier.
 */
export const CJK_SUPPORT_PACKAGE = '\\usepackage[fontset=fandol]{ctex}';

/** True when `source` contains at least one CJK Han ideograph. */
export function containsCjk(source: string): boolean {
  return CJK_HAN_REGEX.test(source);
}

/**
 * Detect whether the user has already set up CJK support in `source` — via a
 * `ctex*` document class or any known CJK `\usepackage`/`\RequirePackage`.
 */
export function hasCjkSupport(source: string): boolean {
  if (CTEX_DOCUMENTCLASS_REGEX.test(source)) return true;
  return extractPackageNames(source).some((name) => USER_CJK_PACKAGE_NAMES.has(name));
}

/**
 * Whether the one-click "add Chinese support" action should be offered for
 * `source`: it has CJK content, doesn't already set up CJK, and has a
 * `\documentclass{...}` we can anchor the insertion to.
 */
export function shouldOfferCjkSupport(source: string): boolean {
  return containsCjk(source) && !hasCjkSupport(source) && matchDocumentClass(source) !== null;
}

/**
 * Character offset of the first `\documentclass{...}` token in `source`, or
 * null. Shared by the CodeLens anchor and {@link insertCjkSupport} so the lens
 * renders on the exact line the insertion targets. (Like the insertion, this is
 * a regex over source text — it does not skip a commented-out `% \documentclass`
 * — but anchor and insertion stay consistent because both use this match.)
 */
export function documentClassOffset(source: string): number | null {
  const match = matchDocumentClass(source);
  return match?.index ?? null;
}

export interface CjkInsertion {
  /** Rewritten source with `\usepackage{ctex}` added. */
  source: string;
  /** 1-based line number the package was inserted on (for the editor to reveal). */
  line: number;
}

/**
 * Insert {@link CJK_SUPPORT_PACKAGE} on its own line immediately after the
 * `\documentclass{...}` line. Unlike the old behaviour, this returns source
 * meant to be *written back to disk* — visible and portable.
 *
 * Returns null when there is no `\documentclass{...}` to anchor to (caller
 * should have gated on {@link shouldOfferCjkSupport} first).
 */
export function insertCjkSupport(source: string): CjkInsertion | null {
  const match = matchDocumentClass(source);
  if (!match || match.index === undefined) return null;

  // Find the end of the line \documentclass sits on, and splice a new line
  // after it. A fresh line (not same-line) keeps the added package readable;
  // this source is persisted, so SyncTeX line-shift concerns don't apply the
  // way they did for the old per-compile injection.
  const afterDocClass = match.index + match[0].length;
  const nextNewline = source.indexOf('\n', afterDocClass);
  const insertAt = nextNewline === -1 ? source.length : nextNewline;

  const before = source.slice(0, insertAt);
  const after = source.slice(insertAt);
  // The inserted package sits on the line after the ones already in `before`.
  const line = before.split('\n').length + 1;

  return {
    source: `${before}\n${CJK_SUPPORT_PACKAGE}${after}`,
    line,
  };
}
