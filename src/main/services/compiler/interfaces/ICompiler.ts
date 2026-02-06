/**
 * @file ICompiler - Unified Compiler Interface
 * @description Defines the contract that all compilers (LaTeX/Typst/Overleaf) must implement, follows Open-Closed Principle
 * @depends EventEmitter
 */

import type { EventEmitter } from 'events';

// ============ Compile Options ============

/**
 * Compile options
 */
export interface CompileOptions {
  /**
   * Specified compile engine
   * @example 'xelatex', 'pdflatex', 'lualatex', 'tectonic', 'typst', 'tinymist'
   */
  engine?: string;

  /**
   * Main file path
   * For multi-file projects, specifies the entry file
   */
  mainFile?: string;

  /**
   * Project root directory
   */
  projectPath?: string;

  /**
   * Output directory
   * Location where compile artifacts are stored
   */
  outputDir?: string;

  /**
   * Output format
   * @default 'pdf'
   */
  outputFormat?: 'pdf' | 'html' | 'svg' | 'png';

  /**
   * Whether to enable draft mode
   * Draft mode skips time-consuming operations (like image processing) to speed up compilation
   */
  draft?: boolean;

  /**
   * Whether to generate SyncTeX file
   * Used for bidirectional synchronization between PDF and source code
   * @default true
   */
  synctex?: boolean;

  /**
   * Additional compiler command-line arguments
   */
  args?: string[];

  /**
   * Environment variable overrides
   */
  env?: Record<string, string>;

  /**
   * Compile timeout (milliseconds)
   * @default 120000 (2 minutes)
   */
  timeout?: number;
}

// ============ Compile Results ============

/**
 * Compile error/warning details
 */
export interface CompileMessage {
  /** Message level */
  level: 'error' | 'warning' | 'info';
  /** Message content */
  message: string;
  /** Source file path (if determinable) */
  file?: string;
  /** Line number (1-based) */
  line?: number;
  /** Column number (1-based) */
  column?: number;
}

/**
 * Compile result
 */
export interface CompileResult {
  /**
   * Whether compilation succeeded
   */
  success: boolean;

  /**
   * Output file path
   * Absolute path of main artifact (e.g., PDF)
   */
  outputPath?: string;

  /**
   * Output file content (Base64 encoded)
   * @deprecated Use outputBuffer instead, Base64 encoding is inefficient
   * Used for in-memory preview, avoids file I/O
   */
  outputData?: string;

  /**
   * Output file binary data
   * High-performance zero-copy transmission method, more efficient than Base64
   */
  outputBuffer?: Uint8Array;

  /**
   * SyncTeX file path
   * Used for bidirectional synchronization between source code and PDF
   */
  synctexPath?: string;

  /**
   * Error message list
   */
  errors: string[];

  /**
   * Warning message list
   */
  warnings: string[];

  /**
   * Structured message list
   * Contains file location information, can be used for editor navigation
   */
  messages?: CompileMessage[];

  /**
   * Compile log raw content
   */
  log?: string;

  /**
   * Compile duration (milliseconds)
   */
  duration?: number;

  /**
   * Additional metadata
   */
  metadata?: Record<string, unknown>;
}

// ============ Progress Reporting ============

/**
 * Compile progress information
 */
export interface CompileProgress {
  /** Progress percentage (0-100) */
  percent: number;
  /** Current stage description */
  stage: string;
  /** Detailed message */
  message?: string;
}

/**
 * Compile log entry
 */
export interface CompileLogEntry {
  /** Timestamp */
  timestamp: number;
  /** Log level */
  level: 'info' | 'warning' | 'error' | 'debug';
  /** Log content */
  message: string;
}

// ============ Event Types ============

/**
 * Compiler event map
 */
export interface CompilerEventMap {
  /** Progress update */
  progress: CompileProgress;
  /** Log output */
  log: CompileLogEntry;
  /** Compilation started */
  start: { mainFile: string; options: CompileOptions };
  /** Compilation completed */
  complete: CompileResult;
  /** Compilation cancelled */
  cancel: void;
}

// ============ Main Interface Definition ============

/**
 * Unified compiler interface
 *
 * All compiler implementations (LaTeX, Typst, Overleaf, etc.) must implement this interface.
 * This allows CompilerRegistry to uniformly manage all compilers.
 */
export interface ICompiler extends EventEmitter {
  // ================= Identity Information =================

  /**
   * Unique identifier
   * @example 'latex-local', 'typst-local', 'overleaf-remote'
   */
  readonly id: string;

  /**
   * Display name
   * @example 'Local LaTeX', 'Typst', 'Overleaf'
   */
  readonly name: string;

  /**
   * Supported file extension list (with dot)
   * @example ['.tex', '.ltx'], ['.typ'], ['.md']
   */
  readonly extensions: string[];

  /**
   * Supported compile engine list
   * @example ['pdflatex', 'xelatex', 'lualatex'], ['typst', 'tinymist']
   */
  readonly engines: string[];

  /**
   * Whether this is a remote compiler
   * Remote compilers may have network latency and quota limits
   */
  readonly isRemote: boolean;

  // ================= Lifecycle Management =================

  /**
   * Check if compiler is available
   * Local compilers check binary files, remote compilers check network connection
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get compiler version
   * @returns Version string or null (if unavailable)
   */
  getVersion(): Promise<string | null>;

  /**
   * Get list of supported engines and their availability
   */
  getAvailableEngines(): Promise<Array<{ engine: string; available: boolean; version?: string }>>;

  // ================= Compilation Operations =================

  /**
   * Execute compilation
   *
   * @param content Source code content (optional)
   *   - If provided, will compile using this content
   *   - If null, will read content from mainFile
   * @param options Compile options
   * @returns Compile result
   */
  compile(content: string | null, options?: CompileOptions): Promise<CompileResult>;

  /**
   * Cancel ongoing compilation
   * @returns Whether cancellation succeeded
   */
  cancel(): boolean;

  /**
   * Check if currently compiling
   */
  isCompiling(): boolean;

  /**
   * Clean auxiliary files (.aux, .log, .out, etc.)
   * @param options Specify project path and other options
   */
  clean(options?: Pick<CompileOptions, 'projectPath' | 'mainFile'>): Promise<void>;

  // ================= Events (inherited from EventEmitter) =================

  /**
   * Listen for progress updates
   */
  on(event: 'progress', listener: (progress: CompileProgress) => void): this;

  /**
   * Listen for log output
   */
  on(event: 'log', listener: (entry: CompileLogEntry) => void): this;

  /**
   * Listen for compilation start
   */
  on(event: 'start', listener: (data: CompilerEventMap['start']) => void): this;

  /**
   * Listen for compilation completion
   */
  on(event: 'complete', listener: (result: CompileResult) => void): this;

  /**
   * Listen for compilation cancellation
   */
  on(event: 'cancel', listener: () => void): this;
}

// ============ Helper Types ============

/**
 * Compiler constructor type
 * Used for factory pattern or dependency injection
 */
export type ICompilerConstructor = new () => ICompiler;

/**
 * Compiler registration information
 */
export interface CompilerRegistration {
  /** Compiler ID */
  id: string;
  /** Compiler instance or constructor */
  compiler: ICompiler | ICompilerConstructor;
  /** Whether enabled */
  enabled?: boolean;
  /** Priority (used when same extension) */
  priority?: number;
  /**
   * Supported file extension list (for indexing during lazy loading)
   * If omitted, compiler will be instantiated immediately to get this information
   */
  extensions?: string[];
  /**
   * Supported compile engine list (for indexing during lazy loading)
   * If omitted, compiler will be instantiated immediately to get this information
   */
  engines?: string[];
}

// ============ Utility Types ============

/**
 * Compiler configuration
 */
export interface CompilerConfig {
  /** Default engine */
  defaultEngine?: string;
  /** Default output directory */
  defaultOutputDir?: string;
  /** Whether to enable draft mode by default */
  defaultDraft?: boolean;
  /** Default timeout */
  defaultTimeout?: number;
  /** Additional default arguments */
  defaultArgs?: string[];
}
