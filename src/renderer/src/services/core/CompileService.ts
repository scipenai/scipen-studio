/**
 * @file CompileService.ts - Compilation Service
 * @description Manages compilers through CompilerRegistry, supports dynamic registration of new language compilers
 * @depends CompilerRegistry, CompilerProviders
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
  Throttler,
} from '../../../../../shared/utils';
import type { EditorTab } from '../../types';
import { createLogger } from '../LogService';
import {
  LaTeXCompilerProvider,
  OverleafCompilerProvider,
  TypstCompilerProvider,
} from './CompilerProviders';
import { CompilerRegistry } from './LanguageFeatureRegistry';

const logger = createLogger('CompileService');

// ====== Type Definitions ======

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic';
export type TypstEngine = 'typst' | 'tinymist';
export type CompileEngine = LatexEngine | TypstEngine | 'overleaf';

export type CompileLogType = 'info' | 'success' | 'warning' | 'error';

export interface CompileLogEntry {
  type: CompileLogType;
  message: string;
  details?: string;
}

export interface CompileOptions {
  engine: CompileEngine;
  mainFile?: string;
  projectPath?: string;
  overleaf?: {
    serverUrl: string;
    projectId: string;
    email?: string;
    cookies?: string;
    remoteCompiler?: string;
  };
  activeTab?: EditorTab;
}

export interface CompileResult {
  success: boolean;
  pdfPath?: string;
  /** @deprecated Use pdfBuffer instead, Base64 encoding is inefficient */
  pdfData?: string;
  pdfBuffer?: ArrayBuffer | Uint8Array;
  synctexPath?: string;
  log?: string;
  errors?: string[];
  warnings?: string[];
  time?: number;
  buildId?: string;
  parsedErrors?: Array<{
    line: number;
    message: string;
    file?: string;
    level?: 'error' | 'warning' | 'info';
    content?: string;
    raw?: string;
  }>;
  parsedWarnings?: Array<{
    line: number;
    message: string;
    file?: string;
    level?: 'error' | 'warning' | 'info';
    content?: string;
    raw?: string;
  }>;
  parsedInfo?: Array<{
    line: number;
    message: string;
    file?: string;
    level?: 'error' | 'warning' | 'info';
    content?: string;
    raw?: string;
  }>;
}

// ====== CompileService Implementation ======

export class CompileService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  /**
   * Compile throttler
   * Using Throttler instead of a simple boolean flag:
   * - Auto-queues rapid consecutive compile requests
   * - Ensures only the last request executes (merges intermediate requests)
   * - Prevents compile task loss
   */
  private readonly _compileThrottler = new Throttler();

  private readonly _compilerRegistry: CompilerRegistry;

  // ====== Event Definitions ======

  private readonly _onDidStartCompile = new Emitter<string>();
  readonly onDidStartCompile: Event<string> = this._onDidStartCompile.event;

  private readonly _onDidFinishCompile = new Emitter<CompileResult>();
  readonly onDidFinishCompile: Event<CompileResult> = this._onDidFinishCompile.event;

  private readonly _onDidLog = new Emitter<CompileLogEntry>();
  readonly onDidLog: Event<CompileLogEntry> = this._onDidLog.event;

  constructor() {
    this._disposables.add(this._onDidStartCompile);
    this._disposables.add(this._onDidFinishCompile);
    this._disposables.add(this._onDidLog);

    this._compilerRegistry = new CompilerRegistry();
    this._disposables.add(this._compilerRegistry);
    this._registerBuiltinProviders();
  }

  private _registerBuiltinProviders(): void {
    this._disposables.add(this._compilerRegistry.register(new LaTeXCompilerProvider(), 10));

    this._disposables.add(this._compilerRegistry.register(new TypstCompilerProvider(), 10));

    this._disposables.add(this._compilerRegistry.register(new OverleafCompilerProvider(), 5));

    logger.info('Builtin compiler providers registered', {
      count: this._compilerRegistry.size,
    });
  }

  get compilerRegistry(): CompilerRegistry {
    return this._compilerRegistry;
  }

  // ====== Getters ======

  get isCompiling(): boolean {
    return this._compileThrottler.isThrottling;
  }

  // ====== Core Compilation Methods ======

  /**
   * Compile file
   * Finds matching compiler Provider through CompilerRegistry
   *
   * Uses Throttler to queue compile requests:
   * - Rapid consecutive requests are merged
   * - Only the last request executes
   * - Prevents compile task loss
   */
  async compile(
    filePath: string,
    content: string,
    options: CompileOptions
  ): Promise<CompileResult> {
    return this._compileThrottler.queue((_token) => this._doCompile(filePath, content, options));
  }

  private async _doCompile(
    filePath: string,
    content: string,
    options: CompileOptions
  ): Promise<CompileResult> {
    this._onDidStartCompile.fire(filePath);
    const startTime = Date.now();

    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    this.log('info', `Compiling: ${fileName}`);
    this.log('info', `File path: ${filePath}`);
    this.log('info', `Content length: ${content.length} characters`);

    let result: CompileResult;

    try {
      const provider = this._compilerRegistry.getCompilerForFile(filePath, options);

      if (!provider) {
        const ext = filePath.split('.').pop() || 'unknown';
        result = {
          success: false,
          errors: [`No compiler found for .${ext} files`],
          time: Date.now() - startTime,
        };
        this.log(
          'error',
          result.errors && result.errors.length > 0
            ? result.errors[0]
            : 'Compilation failed for unknown reason'
        );
        this._onDidFinishCompile.fire(result);
        return result;
      }

      const engineName = options.engine || provider.id.split('-')[0];
      this.log('info', `Using compiler: ${engineName} (${provider.id})`);

      result = await provider.compile(filePath, content, options);

      result.time = Date.now() - startTime;
      this.logCompileResult(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Compile failed', error);
      this.log('error', errorMsg);
      result = {
        success: false,
        errors: [errorMsg],
        time: Date.now() - startTime,
      };
    }

    this._onDidFinishCompile.fire(result);
    return result;
  }

  /**
   * Log compile result
   *
   * Why: errors/warnings may be string arrays or object arrays (LaTeXError/LaTeXWarning)
   * Need to convert to strings uniformly, otherwise passing objects directly causes React render crash (Error #31)
   */
  private logCompileResult(result: CompileResult): void {
    const timeStr = ((result.time || 0) / 1000).toFixed(2);

    if (result.success) {
      this.log('success', `Compilation succeeded! Time: ${timeStr}s`);

      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => {
          const msg = this.formatLogEntry(w);
          this.log('warning', msg);
        });
      }

      if (result.synctexPath) {
        this.log('info', 'SyncTeX enabled (Ctrl+Click to jump)');
      }
      if (result.buildId) {
        this.log('info', `SyncTeX enabled (buildId: ${result.buildId.substring(0, 8)}...)`);
      }
    } else {
      this.log('error', `Compilation failed! Time: ${timeStr}s`);

      if (result.errors && result.errors.length > 0) {
        result.errors.forEach((err) => {
          const msg = this.formatLogEntry(err);
          this.log('error', msg);
        });
      }

      if (result.log) {
        this.log('info', 'Click to view full log', result.log);
      }
    }
  }

  /**
   * Format log entry as string
   *
   * Why: IPC-returned errors/warnings may be LaTeXError/LaTeXWarning objects
   * Need to convert to renderable string format
   */
  private formatLogEntry(
    entry: string | { message?: string; line?: number; file?: string }
  ): string {
    if (typeof entry === 'string') {
      return entry;
    }
    const parts: string[] = [];
    if (entry.file) {
      parts.push(entry.file);
    }
    if (entry.line !== undefined) {
      parts.push(`L${entry.line}`);
    }
    const location = parts.length > 0 ? `[${parts.join(':')}] ` : '';
    return `${location}${entry.message || 'Unknown error'}`;
  }

  // ====== Helper Methods ======

  private log(type: CompileLogType, message: string, details?: string): void {
    this._onDidLog.fire({ type, message, details });
  }

  isTypstFile(filePath: string): boolean {
    return filePath.endsWith('.typ');
  }

  isLatexFile(filePath: string): boolean {
    return filePath.endsWith('.tex') || filePath.endsWith('.latex') || filePath.endsWith('.ltx');
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._disposables.dispose();
  }
}

// ====== Lazy Service Getter ======

let _compileService: CompileService | null = null;

export function getCompileService(): CompileService {
  if (!_compileService) {
    // Use dynamic import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = (globalThis as Record<string, unknown>).__ServiceRegistry as
      | { getServices: () => { compile: CompileService } }
      | undefined;
    if (mod) {
      _compileService = mod.getServices().compile;
    }
  }
  return _compileService!;
}

export function getCompileServiceAsync(): Promise<CompileService> {
  if (_compileService) {
    return Promise.resolve(_compileService);
  }
  // Use dynamic import to avoid circular dependency (ServiceRegistry <-> CompileService)
  return import('./ServiceRegistry').then(({ getServices }) => {
    _compileService = getServices().compile;
    return _compileService;
  });
}

export function _setCompileServiceInstance(instance: CompileService): void {
  _compileService = instance;
}
