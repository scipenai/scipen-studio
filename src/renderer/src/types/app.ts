/**
 * @file app.ts - Application core type definitions
 * @description Defines core data structures such as file nodes, editor state, and application configuration
 */

import type { AIProvider, VLMProvider, WhisperProvider } from './ai';

/** File node type */
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  isExpanded?: boolean;
  /**
   * Whether directory children have been resolved (lazy loading flag)
   * - true: children are loaded
   * - false: children not loaded, need to call resolveChildren when expanding
   * - undefined: backward compatibility, treated as resolved
   */
  isResolved?: boolean;
  _id?: string;
  projectId?: string;
  isFileRef?: boolean;
  isRemote?: boolean;
}

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
  language: string;
  _id?: string;
  projectId?: string;
  isRemote?: boolean;
  needsReload?: boolean;
}

export interface ParsedLogEntry {
  line: number | null;
  file?: string;
  level?: 'error' | 'warning' | 'info';
  message: string;
  content?: string;
  raw?: string;
}

export interface CompilationResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: ArrayBuffer;
  synctexPath?: string;
  errors?: string[];
  warnings?: string[];
  log?: string;
  time?: number;
  parsedErrors?: ParsedLogEntry[];
  parsedWarnings?: ParsedLogEntry[];
  parsedInfo?: ParsedLogEntry[];
}

export interface Diagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
}

export interface CompilationLog {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  details?: string;
}

export interface MarkdownTocItem {
  depth: number;
  text: string;
  id: string;
  line?: number;
}

export interface MarkdownRenderDiagnostic {
  type: 'asset-not-found' | 'blocked-protocol' | 'sanitized-html';
  message: string;
  value?: string;
  line?: number;
}

export interface MarkdownFrontmatterField {
  key: string;
  value: string;
}

export interface MarkdownRenderInput {
  markdown: string;
  filePath: string | null;
  projectPath: string | null;
  theme: UITheme;
}

export interface MarkdownRenderResult {
  html: string;
  toc: MarkdownTocItem[];
  diagnostics: MarkdownRenderDiagnostic[];
  frontmatter: MarkdownFrontmatterField[];
}

export interface FilePdfPreviewState {
  filePath: string;
  pdfPath: string | null;
  pdfData: ArrayBuffer | null;
  isStale: boolean;
  updatedAt: number;
}

export type LaTeXEngine =
  | 'tectonic'
  | 'pdflatex'
  | 'xelatex'
  | 'lualatex'
  | 'wasm-pdftex'
  | 'wasm-xetex';

export type TypstEngine = 'typst' | 'tinymist';

export type CompilerEngine = LaTeXEngine | TypstEngine;

export type UITheme = 'dark' | 'light' | 'system';

export type UILocale = 'zh-CN' | 'en-US';

export type CursorStyle = 'line' | 'block' | 'underline';

export type CursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';

export type WhitespaceMode = 'none' | 'boundary' | 'selection' | 'all';

export type LineHighlightMode = 'none' | 'gutter' | 'line' | 'all';
export interface AppSettings {
  ai: {
    provider: AIProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeout: number;
    completionModel: string;
    streamResponse: boolean;
    contextLength: number;
  };
  vlm: {
    provider: VLMProvider;
    model: string;
    apiKey: string;
    baseUrl: string;
    timeout: number;
  };
  whisper: {
    provider: WhisperProvider;
    model: string;
    apiKey: string;
    baseUrl: string;
    language: string;
    timeout: number;
  };
  editor: {
    fontSize: number;
    fontFamily: string;
    tabSize: number;
    wordWrap: boolean;
    minimap: boolean;
    lineNumbers: boolean;
    autoCompletion: boolean;
    ghostText: boolean;
    cursorStyle: CursorStyle;
    cursorBlinking: CursorBlinking;
    bracketPairColorization: boolean;
    highlightActiveLine: boolean;
    showWhitespace: WhitespaceMode;
    formatOnSave: boolean;
    indentGuides: boolean;
    renderLineHighlight: LineHighlightMode;
    smoothScrolling: boolean;
    stickyScroll: boolean;
  };
  compiler: {
    engine: LaTeXEngine;
    typstEngine: TypstEngine;
    autoCompile: boolean;
    compileOnSave: boolean;
    autoCompileDelay: number;
    synctex: boolean;
    shellEscape: boolean;
    outputDirectory: string;
    cleanAuxFiles: boolean;
    stopOnFirstError: boolean;
    texliveEndpoint: string;
    overleaf: {
      serverUrl: string;
      cookies: string;
      projectId: string;
    };
  };
  ui: {
    theme: UITheme;
    language: UILocale;
    /** 聊天面板正文/输入字号(px),12–20 可调。 */
    chatFontSize: number;
    previewWidth: number;
    rightPanelWidth: number;
    sidebarPosition: 'left' | 'right';
  };
  upload: {
    maxSizePlainText: number;
    maxSizeRichFormat: number;
    maxSizeAudio: number;
    supportedFormats: string[];
    autoChunking: boolean;
  };
  shortcuts: {
    compile: string;
    save: string;
    commandPalette: string;
    chatWithSelection: string;
    togglePreview: string;
    newWindow: string;
    inlineEdit: string;
  };
  assistant: {
    autoFixCompileErrors: boolean;
    maxAutoFixRetries: number;
  };
}
