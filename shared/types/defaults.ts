/**
 * @file Default Configuration Values
 * @description Single source of truth for default settings
 * @depends None (pure constant definitions)
 */

// ====== UI Defaults ======
export const DEFAULT_THEME: 'light' | 'dark' | 'system' = 'system';
export const DEFAULT_LANGUAGE: 'zh-CN' | 'en-US' = 'zh-CN';

// ====== Editor Defaults ======
export const DEFAULT_EDITOR_FONT_SIZE = 14;
export const DEFAULT_EDITOR_FONT_FAMILY = 'Consolas, "Courier New", monospace';
export const DEFAULT_EDITOR_TAB_SIZE = 2;
export const DEFAULT_EDITOR_WORD_WRAP = true;
export const DEFAULT_EDITOR_LINE_NUMBERS = true;
export const DEFAULT_EDITOR_MINIMAP = false;
export const DEFAULT_EDITOR_AUTO_COMPLETION = true;
export const DEFAULT_EDITOR_GHOST_TEXT = true;

// ====== Compiler Defaults ======
export const DEFAULT_COMPILER_ENGINE = 'xelatex';
export const DEFAULT_COMPILER_AUTO_COMPILE = false;
export const DEFAULT_COMPILER_COMPILE_ON_SAVE = true;
export const DEFAULT_COMPILER_OUTPUT_FORMAT = 'pdf';

// ====== RAG Defaults ======
export const DEFAULT_RAG_ENABLED = true;
export const DEFAULT_RAG_MAX_RESULTS = 5;
export const DEFAULT_RAG_SCORE_THRESHOLD = 0.7;

// ====== Aggregated Export ======
export const DEFAULTS = {
  ui: {
    theme: DEFAULT_THEME,
    language: DEFAULT_LANGUAGE,
  },
  editor: {
    fontSize: DEFAULT_EDITOR_FONT_SIZE,
    fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
    tabSize: DEFAULT_EDITOR_TAB_SIZE,
    wordWrap: DEFAULT_EDITOR_WORD_WRAP,
    lineNumbers: DEFAULT_EDITOR_LINE_NUMBERS,
    minimap: DEFAULT_EDITOR_MINIMAP,
    autoCompletion: DEFAULT_EDITOR_AUTO_COMPLETION,
    ghostText: DEFAULT_EDITOR_GHOST_TEXT,
  },
  compiler: {
    engine: DEFAULT_COMPILER_ENGINE,
    autoCompile: DEFAULT_COMPILER_AUTO_COMPILE,
    compileOnSave: DEFAULT_COMPILER_COMPILE_ON_SAVE,
    outputFormat: DEFAULT_COMPILER_OUTPUT_FORMAT,
  },
  rag: {
    enabled: DEFAULT_RAG_ENABLED,
    maxResults: DEFAULT_RAG_MAX_RESULTS,
    scoreThreshold: DEFAULT_RAG_SCORE_THRESHOLD,
  },
} as const;
