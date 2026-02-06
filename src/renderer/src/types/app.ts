/**
 * @file app.ts - Application core type definitions
 * @description Defines core data structures such as file nodes, editor state, and application configuration
 */

import type { AIProvider, EmbeddingProvider, VLMProvider, WhisperProvider } from './ai';

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
  isRemote?: boolean;
  needsReload?: boolean;
}

/**
 * KnowledgeBase
 *
 * Note: createdAt and updatedAt are now in ISO 8601 string format
 * Example: "2024-01-10T12:00:00.000Z"
 */
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  documentCount: number;
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
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

export type LaTeXEngine = 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex' | 'overleaf';

export type TypstEngine = 'typst' | 'tinymist';

export type CompilerEngine = LaTeXEngine | TypstEngine;

export type OverleafCompiler = 'pdflatex' | 'xelatex' | 'lualatex';

export type UITheme = 'dark' | 'light' | 'system';

export type UILocale = 'zh-CN' | 'en-US';

export type CursorStyle = 'line' | 'block' | 'underline';

export type CursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';

export type WhitespaceMode = 'none' | 'boundary' | 'selection' | 'all';

export type LineHighlightMode = 'none' | 'gutter' | 'line' | 'all';

export type RerankProvider =
  | 'dashscope'
  | 'openai'
  | 'cohere'
  | 'jina'
  | 'local'
  | 'siliconflow'
  | 'aihubmix'
  | 'custom';

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
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    apiKey: string;
    baseUrl: string;
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
    overleaf: {
      serverUrl: string;
      cookies: string;
      projectId: string;
      remoteCompiler: OverleafCompiler;
    };
  };
  rag: {
    enabled: boolean;
    maxResults: number;
    scoreThreshold: number;
    local: {
      chunkSize: number;
      chunkOverlap: number;
      useHybridSearch: boolean;
      bm25Weight: number;
      vectorWeight: number;
    };
    advanced: {
      enableQueryRewrite: boolean;
      enableRerank: boolean;
      enableContextRouting: boolean;
      enableBilingualSearch: boolean;
      rerankProvider?: RerankProvider;
      rerankModel?: string;
      rerankApiKey?: string;
      rerankBaseUrl?: string;
    };
  };
  ui: {
    theme: UITheme;
    language: UILocale;
    previewWidth: number;
    rightPanelWidth: number;
    sidebarPosition: 'left' | 'right';
  };
  agents: {
    syncVLMConfig: boolean;
    timeout: number;
    pdf2latex: {
      maxConcurrentPages: number;
    };
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
    aiPolish: string;
    aiChat: string;
    togglePreview: string;
    newWindow: string;
  };
  knowledge: {
    enabled: boolean;
    embeddingModel: string;
    chunkSize: number;
    chunkOverlap: number;
    maxResults: number;
    scoreThreshold: number;
  };
}
