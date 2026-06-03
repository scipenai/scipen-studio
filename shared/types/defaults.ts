/**
 * @file Default Configuration Values
 * @description Single source of truth for default settings
 * @depends None (pure constant definitions)
 */

// ====== UI Defaults ======
export const DEFAULT_THEME: 'light' | 'dark' | 'system' = 'system';
export const DEFAULT_LANGUAGE: 'zh-CN' | 'en-US' = 'zh-CN';
/** 聊天面板正文/输入字号(px),设置内 12–20 可调,默认 14;驱动 --chat-font-size。 */
export const DEFAULT_CHAT_FONT_SIZE = 14;

// ====== Editor Defaults ======
export const DEFAULT_EDITOR_FONT_SIZE = 14;
export const DEFAULT_EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace';
export const DEFAULT_EDITOR_TAB_SIZE = 2;
export const DEFAULT_EDITOR_WORD_WRAP = true;
export const DEFAULT_EDITOR_LINE_NUMBERS = true;
export const DEFAULT_EDITOR_MINIMAP = false;
export const DEFAULT_EDITOR_AUTO_COMPLETION = true;
export const DEFAULT_EDITOR_GHOST_TEXT = true;

// ====== Gateway Host Defaults ======
export const DEFAULT_GATEWAY_HOST_ENABLED = false;
export const DEFAULT_GATEWAY_HOST_PORT = 6178;

// ====== Compiler Defaults ======
export const DEFAULT_COMPILER_ENGINE = 'xelatex';
export const DEFAULT_COMPILER_AUTO_COMPILE = false;
export const DEFAULT_COMPILER_COMPILE_ON_SAVE = true;
export const DEFAULT_COMPILER_OUTPUT_FORMAT = 'pdf';

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
} as const;
