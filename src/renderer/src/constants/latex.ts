/**
 * @file latex.ts - LaTeX-related constants
 * @description Defines constants for LaTeX compilation engines, file extensions, and compilation options
 */

/** LaTeX compilation engine */
export const LATEX_ENGINES = {
  TECTONIC: 'tectonic',
  PDFLATEX: 'pdflatex',
  XELATEX: 'xelatex',
  LUALATEX: 'lualatex',
} as const;

/** Default LaTeX engine */
export const DEFAULT_LATEX_ENGINE = LATEX_ENGINES.XELATEX;

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
