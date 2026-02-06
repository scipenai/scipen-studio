/**
 * @file ILanguageServer - Unified language server interface
 * @description Contract for all LSP implementations. Follows Open-Closed Principle.
 * @implements TexLabService (LaTeX), TinymistService (Typst)
 */

import type { EventEmitter } from 'events';

// ====== LSP Type Definitions ======

/** LSP position (0-based line and character). */
export interface LSPPosition {
  line: number;
  character: number;
}

/** LSP range (start inclusive, end exclusive). */
export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

/** LSP location (URI + range). */
export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

/** LSP diagnostic (severity: 1=Error, 2=Warning, 3=Info, 4=Hint). */
export interface LSPDiagnostic {
  range: LSPRange;
  severity?: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: LSPLocation;
    message: string;
  }>;
}

/** LSP completion item. */
export interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: 1 | 2; // PlainText, Snippet
  textEdit?: {
    range: LSPRange;
    newText: string;
  };
  sortText?: string;
  filterText?: string;
}

/** LSP hover result. */
export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

/** LSP symbol (flat). */
export interface LSPSymbol {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

/** LSP document symbol (hierarchical). */
export interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

/** LSP text edit. */
export interface LSPTextEdit {
  range: LSPRange;
  newText: string;
}

/** LSP incremental document change event. */
export interface LSPTextDocumentContentChangeEvent {
  /** Change range (empty means full update) */
  range?: LSPRange;
  /** Replaced text length */
  rangeLength?: number;
  /** New text */
  text: string;
}

// ====== Start Options ======

/** LSP server start options. */
export interface LSPStartOptions {
  /** Virtual document mode (for remote projects) */
  virtual?: boolean;
  /** Additional initialization parameters */
  initializationOptions?: Record<string, unknown>;
  /** Environment variable overrides */
  env?: Record<string, string>;
  /** Enable verbose logging */
  debug?: boolean;
}

// ====== Server Capabilities ======

/** LSP server capabilities. */
export interface LSPServerCapabilities {
  completion?: boolean;
  hover?: boolean;
  definition?: boolean;
  references?: boolean;
  documentSymbol?: boolean;
  formatting?: boolean;
  rename?: boolean;
  codeAction?: boolean;
  foldingRange?: boolean;
  semanticTokens?: boolean;
}

// ====== Event Types ======

/** LSP event map. */
export interface LSPEventMap {
  diagnostics: { filePath: string; diagnostics: LSPDiagnostic[] };
  initialized: void;
  message: { type: number; message: string };
  exit: { code: number | null; signal: string | null };
  error: Error;
}

// ====== Main Interface ======

/** Unified language server interface - all LSP implementations must implement this. */
export interface ILanguageServer extends EventEmitter {
  // ====== Identity ======
  readonly id: string;
  readonly name: string;
  readonly languageIds: string[];
  readonly extensions: string[];
  readonly capabilities: LSPServerCapabilities;

  // ====== Lifecycle ======
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  start(rootPath: string, options?: LSPStartOptions): Promise<boolean>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isInitialized(): boolean;
  isVirtualMode(): boolean;
  getPid(): number | null;

  // ====== Document Sync ======
  openDocument(uri: string, content: string, languageId?: string): Promise<void>;
  updateDocument(uri: string, content: string): Promise<void>;
  updateDocumentIncremental(
    uri: string,
    changes: LSPTextDocumentContentChangeEvent[]
  ): Promise<void>;
  saveDocument(uri: string): Promise<void>;
  closeDocument(uri: string): Promise<void>;

  // ====== Language Features ======
  getCompletions(uri: string, position: LSPPosition): Promise<LSPCompletionItem[]>;
  getHover(uri: string, position: LSPPosition): Promise<LSPHover | null>;
  getDefinition(uri: string, position: LSPPosition): Promise<LSPLocation | LSPLocation[] | null>;
  getReferences(
    uri: string,
    position: LSPPosition,
    includeDeclaration?: boolean
  ): Promise<LSPLocation[]>;
  getDocumentSymbols(uri: string): Promise<LSPDocumentSymbol[] | LSPSymbol[]>;
  formatDocument(uri: string): Promise<LSPTextEdit[]>;

  // ====== Events ======
  on(event: 'diagnostics', listener: (data: LSPEventMap['diagnostics']) => void): this;
  on(event: 'initialized', listener: () => void): this;
  on(event: 'message', listener: (data: LSPEventMap['message']) => void): this;
  on(event: 'exit', listener: (data: LSPEventMap['exit']) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

// ====== Helper Types ======

/** Language server constructor type. */
export type ILanguageServerConstructor = new () => ILanguageServer;

/** Language server registration entry. */
export interface LanguageServerRegistration {
  id: string;
  server: ILanguageServer | ILanguageServerConstructor;
  enabled?: boolean;
  priority?: number;
  /** For lazy loading index - if omitted, server instantiates immediately */
  languageIds?: string[];
  /** For lazy loading index - if omitted, server instantiates immediately */
  extensions?: string[];
}
