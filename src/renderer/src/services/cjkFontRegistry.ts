/**
 * @file cjkFontRegistry.ts - Shared CJK font asset registry
 * @description Single source of truth for the Simplified Chinese font set
 *              bundled under `public/wasm/typst-ts/fonts/` by
 *              `scripts/download-typst-wasm.js --cjk`.
 *
 *              Both wasm engines (Typst.ts and BusyTeX) need these fonts:
 *                - Typst.ts pulls them from its own manifest at worker init
 *                  (already wired in `typst-compile-worker.js`).
 *                - BusyTeX needs them mounted into its in-memory VFS before
 *                  every XeLaTeX / LuaLaTeX compile, alongside a tiny
 *                  `scipencjk.sty` shim that hides the font filenames and
 *                  Path= options behind a single `\usepackage{scipencjk}`.
 *
 *              Hard-coding the filenames in two places (downloader script +
 *              this registry) is intentional: a name mismatch surfaces as a
 *              loud 404 at runtime rather than a silent CJK regression. The
 *              alternative (probe the directory at runtime) costs an extra
 *              fetch per session and still can't catch typos.
 *
 *              The font binaries live under the `scipen-wasm://typst-ts/`
 *              namespace because the typst-ts downloader put them there
 *              (avoids duplicating ~52 MB into a busytex/ mirror). Both
 *              engines share the same handler in `WasmAssetProtocol.ts`.
 */

/**
 * Font filename + the path it should be mounted at inside BusyTeX's VFS.
 * `vfsPath` is what user documents see in `\setCJKmainfont[Path=fonts/]{...}`
 * — keep them flat under `fonts/` so the Path option is a single segment.
 */
export interface CjkFontAsset {
  /** Filename under `public/wasm/typst-ts/fonts/`. */
  filename: string;
  /** Path inside BusyTeX VFS where the binary will be written. */
  vfsPath: string;
}

/**
 * Asset list MUST stay in lockstep with the `CJK_FONTS` array in
 * `scripts/download-typst-wasm.js`. Order is irrelevant — mounting is
 * parallelised in {@link fetchCjkFontBinaries}.
 */
export const CJK_FONT_ASSETS: readonly CjkFontAsset[] = [
  { filename: 'NotoSerifSC-Regular.otf', vfsPath: 'fonts/NotoSerifSC-Regular.otf' },
  { filename: 'NotoSerifSC-Bold.otf', vfsPath: 'fonts/NotoSerifSC-Bold.otf' },
  { filename: 'NotoSansSC-Regular.otf', vfsPath: 'fonts/NotoSansSC-Regular.otf' },
  { filename: 'NotoSansSC-Bold.otf', vfsPath: 'fonts/NotoSansSC-Bold.otf' },
  {
    filename: 'NotoSansMonoCJKsc-Regular.otf',
    vfsPath: 'fonts/NotoSansMonoCJKsc-Regular.otf',
  },
];

/**
 * Base URL for the shared font store. Routed through `scipen-wasm://` for
 * the same fetch-from-file:// reasons documented in `WasmAssetProtocol.ts`
 * — a renderer Worker spawned from `file://` cannot fetch `file://` URLs
 * but can fetch from a privileged custom protocol.
 */
const FONT_BASE_URL = 'scipen-wasm://typst-ts/fonts';

/** Resolve a font filename to its `scipen-wasm://` fetch URL. */
export function resolveCjkFontUrl(filename: string): string {
  return `${FONT_BASE_URL}/${filename}`;
}

/**
 * Fetched font binary (or any other VFS-bound blob — see `SCIPENCJK_STY`),
 * ready to write into a wasm VFS. `bytes` is owned by the caller — re-use
 * across compiles is fine (BusyTeX's worker postMessage clones, so the
 * original is not consumed).
 */
export interface CjkFontBinary {
  vfsPath: string;
  bytes: Uint8Array;
}

/**
 * The `scipencjk.sty` shim users get via `\usepackage{scipencjk}`. Hides:
 *   - which Chinese fonts we bundle (so swapping Noto → Source Han later
 *     is a one-line registry change, not a user-doc migration);
 *   - the `Path=fonts/` plumbing that exists only because BusyTeX has no
 *     fontconfig database to translate family names → filenames;
 *   - the right xeCJK invocation syntax (single bracket containing both
 *     Path and BoldFont — the double-bracket form fontspec accepts is
 *     not what xeCJK's redefined macro takes).
 *
 * Mounted at the VFS root (alongside `main.tex`), not under
 * `tex/latex/local/`, because kpathsea's first search path is CWD and the
 * BusyTeX texmf tree layout is opaque from outside. CWD placement also
 * means the user can `\input{scipencjk.sty}` directly if they ever need
 * to inspect or override one of the macros.
 */
const SCIPENCJK_STY = `\\NeedsTeXFormat{LaTeX2e}
\\ProvidesPackage{scipencjk}[2026/06/24 SciPen Studio Simplified Chinese fonts]
%
% Loaded by \\usepackage{scipencjk}. Set up Noto CJK SC for XeLaTeX/LuaLaTeX
% using the fonts mounted at /fonts/ by BusyTexEngine.mountCjkFonts().
%
\\RequirePackage{fontspec}
\\RequirePackage{xeCJK}
\\setCJKmainfont[Path=fonts/, BoldFont=NotoSerifSC-Bold.otf]{NotoSerifSC-Regular.otf}
\\setCJKsansfont[Path=fonts/, BoldFont=NotoSansSC-Bold.otf]{NotoSansSC-Regular.otf}
\\setCJKmonofont[Path=fonts/]{NotoSansMonoCJKsc-Regular.otf}
\\endinput
`;

/** VFS location of the `.sty` shim — root, next to the user's `main.tex`. */
export const SCIPENCJK_STY_VFS_PATH = 'scipencjk.sty';

// ===== Auto-injection =====

/**
 * Regex catching any CJK Unified Ideograph (BMP block U+4E00-U+9FFF +
 * Extension A U+3400-U+4DBF). Covers the overwhelming majority of Han
 * characters in real documents. We don't include CJK symbols/punctuation
 * or kana — those frequently coexist with pure Latin docs (e.g. a citation
 * containing a Japanese title) and aren't a reliable signal that the body
 * needs xeCJK loaded.
 *
 * The match is intentionally cheap: one regex test over the source string,
 * runs once per compile on the main file only. For a 100 KB doc it costs
 * ~0.1 ms — well below the noise floor of a wasm compile cycle.
 *
 * `\u`-escaped (not literal glyphs) so this file stays single-language for
 * grep/blame and clears `npm run lint:no-cjk` without an allow-cjk marker.
 */
const CJK_HAN_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * Matches `\documentclass[opts]{class}` (with optional whitespace and an
 * optional `[options]` block). We need the END of this token to know where
 * to splice the auto-injected `\usepackage`.
 *
 * Caveat: this is a regex over LaTeX source, not a parser. Edge cases that
 * intentionally fall through to "no injection":
 *   - The literal string appears inside a `%`-comment on the same line —
 *     we don't strip comments; the regex still matches and we inject after
 *     it, which is a no-op because comments end at \n and the injection is
 *     after a real `\documentclass{...}`. Safe.
 *   - Verbatim/listing blocks containing fake `\documentclass{...}` —
 *     the first match wins, which IS the real one in 99.9% of real docs.
 *   - Class name with `}` inside — not valid LaTeX, fall through.
 */
const DOCUMENTCLASS_REGEX = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]+\}/;

/**
 * Macros that already configure CJK rendering one way or another. If the
 * user wrote any of these, we step away — they're driving. Match is case-
 * sensitive (LaTeX macros are).
 *
 * Why these specific names:
 *   - `ctex` / `xeCJK` / `CJK` / `xeCJKfntef` — the standard CJK packages
 *   - `scipencjk` — our own shim, in case a user added it explicitly
 *   - `luatexja` / `luatexja-fontspec` — the LuaLaTeX equivalent
 * We deliberately DO NOT pattern-match `\setCJKmainfont` etc., because a
 * user could write those AFTER `\usepackage{xeCJK}` and we'd already see
 * xeCJK in the package list; that's the cleaner signal.
 */
const USER_PACKAGE_REGEX = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const USER_CJK_PACKAGE_NAMES = new Set([
  'ctex',
  'xeCJK',
  'xeCJKfntef',
  'CJK',
  'CJKutf8',
  'scipencjk',
  'luatexja',
  'luatexja-fontspec',
]);

/** Engines that can actually USE the `scipencjk.sty` shim (xeCJK is XeTeX-only). */
type CjkInjectableEngine = 'xetex';

/**
 * Detect whether the user has hand-rolled CJK support in `source`. Returns
 * true for any `\usepackage{...}` or `\RequirePackage{...}` whose argument
 * — split on `,` for the `\usepackage{a,b,c}` shorthand — names one of the
 * known CJK packages.
 */
function hasUserManagedCjk(source: string): boolean {
  // Reset lastIndex so successive calls don't skip matches (regex is /g).
  USER_PACKAGE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = USER_PACKAGE_REGEX.exec(source);
  while (match !== null) {
    const names = match[1].split(',').map((s) => s.trim());
    for (const name of names) {
      if (USER_CJK_PACKAGE_NAMES.has(name)) return true;
    }
    match = USER_PACKAGE_REGEX.exec(source);
  }
  return false;
}

export interface AutoInjectResult {
  /** Source to feed the compiler — may equal `original` when no injection happened. */
  source: string;
  /** True iff we modified the source. Caller uses this to emit a "transparently enabled CJK" log. */
  injected: boolean;
}

/**
 * Transparently inject `\usepackage{scipencjk}` on the same line as
 * `\documentclass{...}` so a user-edited `.tex` file containing Chinese
 * characters compiles via wasm-xetex without any explicit `\usepackage`
 * — AND the on-disk source stays portable to other LaTeX environments
 * that have ctex/xeCJK installed.
 *
 * SAME LINE matters for SyncTeX: a newline would shift every subsequent
 * line by 1, breaking forward/inverse search. Splicing the package call
 * inside the same line keeps user-line ↔ wasm-line bijective.
 *
 * Skipped (returns original unchanged) when ANY of:
 *   - engine isn't 'xetex' (pdftex can't fontspec; lualatex needs luatexja,
 *     not xeCJK — a separate code path we don't have yet);
 *   - source has no CJK Unified Ideographs (Latin doc, no win to inject);
 *   - source already loads ctex / xeCJK / scipencjk / etc.;
 *   - source has no `\documentclass{...}` (probably a fragment or
 *     unconventional layout — better to not silently mutate).
 *
 * @param source   the user's tex content (NEVER written back to disk)
 * @param engine   the WASM engine selected for this compile
 */
export function autoInjectCjkPreamble(
  source: string,
  engine: CjkInjectableEngine | string
): AutoInjectResult {
  if (engine !== 'xetex') return { source, injected: false };
  if (!CJK_HAN_REGEX.test(source)) return { source, injected: false };
  if (hasUserManagedCjk(source)) return { source, injected: false };

  const docClassMatch = source.match(DOCUMENTCLASS_REGEX);
  if (!docClassMatch || docClassMatch.index === undefined) {
    return { source, injected: false };
  }

  // Splice on SAME LINE, immediately after the closing brace of \documentclass.
  // No separator — `\documentclass{article}\usepackage{scipencjk}` is valid
  // LaTeX and avoids shifting column counts on the host line.
  const insertPos = docClassMatch.index + docClassMatch[0].length;
  const before = source.slice(0, insertPos);
  const after = source.slice(insertPos);
  return {
    source: `${before}\\usepackage{scipencjk}${after}`,
    injected: true,
  };
}

/**
 * Pull every CJK font from the bundled asset store in parallel, and append
 * the in-memory `scipencjk.sty` shim. Returns one staging list the engine
 * can splice into its per-compile file payload without knowing or caring
 * which entries are binary fonts vs source files.
 *
 * Failure mode: a missing font is a build/packaging fault (the downloader
 * either wasn't run with `--cjk` or the file is genuinely absent). We
 * surface it as a thrown error rather than silently falling back to
 * Latin-only — silently shipping broken CJK rendering would waste a user's
 * compile cycle and not tell them why glyphs are missing.
 */
export async function fetchCjkFontBinaries(): Promise<CjkFontBinary[]> {
  const fonts = await Promise.all(
    CJK_FONT_ASSETS.map(async (asset) => {
      const url = resolveCjkFontUrl(asset.filename);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `CJK font fetch failed (HTTP ${response.status}) at ${url}. ` +
            'Run "npm run download:typst-wasm:cjk" to (re)populate the font set.'
        );
      }
      const buffer = await response.arrayBuffer();
      return { vfsPath: asset.vfsPath, bytes: new Uint8Array(buffer) };
    })
  );
  // Encode the shim as UTF-8 bytes. BusyTeX's VFS accepts string OR
  // Uint8Array for `contents`, but we keep the type uniform so the engine
  // doesn't need a union just for one .sty file.
  fonts.push({
    vfsPath: SCIPENCJK_STY_VFS_PATH,
    bytes: new TextEncoder().encode(SCIPENCJK_STY),
  });
  return fonts;
}
