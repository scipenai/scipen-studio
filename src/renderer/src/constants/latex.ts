/**
 * @file latex.ts - LaTeX-related constants
 * @description Defines constants for LaTeX compilation engines, file extensions, and compilation options
 */

/** LaTeX compilation engine */
export const LATEX_ENGINES = {
  /**
   * Resolve at compile time: prefer a locally-installed engine (xelatex →
   * lualatex → tectonic), falling back to the WASM engine when none is found.
   * See resolveAutoLatexEngine in CompileService.
   */
  AUTO: 'auto',
  TECTONIC: 'tectonic',
  PDFLATEX: 'pdflatex',
  XELATEX: 'xelatex',
  LUALATEX: 'lualatex',
} as const;

/** Default LaTeX engine — local-first via {@link LATEX_ENGINES.AUTO}. */
export const DEFAULT_LATEX_ENGINE = LATEX_ENGINES.AUTO;

/**
 * Default on-demand TeX Live endpoint for the WASM engine. Missing packages
 * (ctex/xeCJK/fandol, tikz libraries, etc.) are fetched from here at compile
 * time. Used as the settings default AND as the fallback when the user's
 * configured endpoint is blank.
 */
export const DEFAULT_TEXLIVE_ENDPOINT = 'https://texlive2026.texlyre.org';

/** Overleaf default compiler */
export const DEFAULT_OVERLEAF_COMPILER = LATEX_ENGINES.PDFLATEX;

/** LaTeX auxiliary file extensions (for cleanup) */
export const LATEX_AUX_EXTENSIONS = [
  '.aux',
  '.log',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.bbl',
  '.blg',
  '.idx',
  '.ind',
  '.ilg',
  '.nav',
  '.snm',
  '.vrb',
  '.fls',
  '.fdb_latexmk',
  '.synctex.gz',
  '.synctex',
] as const;

/** LaTeX configuration files */
export const LATEX_CONFIG_FILES = {
  LATEXMKRC: '.latexmkrc',
  FDB_LATEXMK: '.fdb_latexmk',
} as const;

/** LaTeX file extensions */
export const LATEX_FILE_EXTENSIONS = ['tex', 'latex', 'ltx', 'sty', 'cls', 'bib'] as const;
