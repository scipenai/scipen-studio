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
  toDisposable,
} from '../../../../../shared/utils';
import type { CompileProgressPayload } from '../../../../../shared/ipc/compile-contract';
import type { EditorTab } from '../../types';
import { api } from '../../api';
import { createLogger } from '../LogService';
import {
  LaTeXCompilerProvider,
  TypstCompilerProvider,
  TypstWasmCompilerProvider,
  WASMCompilerProvider,
} from './CompilerProviders';
import { CompilerRegistry, type CompilerProvider } from './LanguageFeatureRegistry';
import { ProjectService } from './ProjectService';
import { getSettingsService } from './ServiceRegistry';
import { hasCompiledWithWasm, rememberWasmCompile } from './wasmPrewarmMemory';
import {
  getLatexCapabilities,
  isLocalLatexEngine,
  resolveAutoLatexEngine,
} from './latexEngineResolver';

const logger = createLogger('CompileService');

/**
 * How long after a project opens before the engine prewarm is even
 * considered. Long enough for the startup storm (Monaco, LSP spawn, pdf.js,
 * file indexing) to finish — warming during it is what made the app feel
 * frozen for ~20 s.
 */
const PREWARM_DELAY_MS = 30_000;

/** True for engines that run in-renderer and therefore have a cold start. */
function isWasmEngine(engine: string | undefined): boolean {
  return typeof engine === 'string' && engine.startsWith('wasm-');
}

/**
 * Fallback engine used when the `auto`-resolved local engine turns out to be
 * unusable (e.g. the binary vanished after the capability probe).
 */
const AUTO_WASM_FALLBACK = 'wasm-xetex';

/**
 * Detect a "the LaTeX binary isn't actually available" failure — narrowly.
 *
 * The compile worker emits `<engine> not found. Please install ...` (and sets
 * `error.code === 'ENOENT'`) only when the binary itself is missing. We must
 * NOT match the far more common LaTeX `! LaTeX Error: File \`foo.sty' not
 * found.` / `Font ... not found`, which would trigger a pointless (and also
 * failing) WASM re-compile and bury the real, actionable error.
 */
function isMissingEngineFailure(result: CompileResult): boolean {
  const haystack = [result.log ?? '', ...(result.errors ?? [])].join('\n');
  return /\bENOENT\b|not found\.\s*please install|command not found|is not recognized as/i.test(
    haystack
  );
}

// ====== Type Definitions ======

// 'auto' is a settings-level selection resolved to a concrete engine by
// _resolveAutoEngine before provider routing; providers never see it.
export type LatexEngine = 'auto' | 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic';
export type WasmEngine = 'wasm-pdftex' | 'wasm-xetex' | 'wasm-lualatex';
export type TypstEngine = 'typst' | 'tinymist' | 'wasm-typst';
export type CompileEngine = LatexEngine | WasmEngine | TypstEngine;

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
  activeTab?: EditorTab;
}

export interface CompileResult {
  success: boolean;
  /** User cancelled this compile (stop button) — a neutral outcome, not a failure. */
  cancelled?: boolean;
  /** Source file path that triggered the compile, used to disambiguate per-file results */
  sourceFile?: string;
  pdfPath?: string;
  pdfBuffer?: ArrayBuffer | Uint8Array;
  synctexPath?: string;
  synctexBuffer?: Uint8Array;
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
  private _currentProvider: CompilerProvider | null = null;

  // ====== Event Definitions ======

  private readonly _onDidStartCompile = new Emitter<string>();
  readonly onDidStartCompile: Event<string> = this._onDidStartCompile.event;

  private readonly _onDidFinishCompile = new Emitter<CompileResult>();
  readonly onDidFinishCompile: Event<CompileResult> = this._onDidFinishCompile.event;

  private readonly _onDidLog = new Emitter<CompileLogEntry>();
  readonly onDidLog: Event<CompileLogEntry> = this._onDidLog.event;

  /**
   * Live compile phase stream. Two producers, one consumer-facing event:
   *   - WASM engines emit renderer-internally via the `onPhase` callback this
   *     service injects into CompilerOptions (the engine runs in this
   *     process — no IPC).
   *   - CLI engines push through the `Compile_Progress` IPC event (main
   *     process broadcasts the compile worker's progress), subscribed here.
   * UIService fans this out to the log panel / preview overlay.
   */
  private readonly _onDidCompilePhase = new Emitter<CompileProgressPayload>();
  readonly onDidCompilePhase: Event<CompileProgressPayload> = this._onDidCompilePhase.event;

  constructor() {
    this._disposables.add(this._onDidStartCompile);
    this._disposables.add(this._onDidFinishCompile);
    this._disposables.add(this._onDidLog);
    this._disposables.add(this._onDidCompilePhase);

    this._compilerRegistry = new CompilerRegistry();
    this._disposables.add(this._compilerRegistry);
    this._registerBuiltinProviders();

    // CLI engines: the main process broadcasts the compile worker's progress
    // over `Compile_Progress`; merge it into the same phase stream the WASM
    // providers feed locally. The subscription is unconditional and lives
    // for the service lifetime — payloads arriving outside a compile (should
    // not happen; compiles are queued) are still harmless log lines.
    this._disposables.add(
      toDisposable(api.compile.onProgress((phase) => this._onDidCompilePhase.fire(phase)))
    );

    // Engine prewarm. Deliberately conservative — see `_schedulePrewarm` for
    // why this is gated on prior use and deferred well past startup.
    //
    // ProjectService.getInstance() rather than getProjectService(): this
    // constructor runs *inside* ServiceRegistry's constructor, so reaching
    // back through the registry would re-enter its getInstance() before the
    // singleton is assigned. ProjectService owns its own singleton.
    this._disposables.add(
      ProjectService.getInstance().onDidChangeProject((e) => {
        this._cancelPrewarm();
        if (e.path) this._schedulePrewarm(e.path);
      })
    );
    this._disposables.add(this._onDidStartCompile.event(() => this._cancelPrewarm()));
    this._disposables.add(toDisposable(() => this._cancelPrewarm()));
  }

  /** Pending prewarm deferral, if any. Cleared by {@link _cancelPrewarm}. */
  private _prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  private _prewarmIdleHandle: number | null = null;

  private _cancelPrewarm(): void {
    if (this._prewarmTimer !== null) {
      clearTimeout(this._prewarmTimer);
      this._prewarmTimer = null;
    }
    if (this._prewarmIdleHandle !== null) {
      const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback;
      cancelIdle?.(this._prewarmIdleHandle);
      this._prewarmIdleHandle = null;
    }
  }

  /**
   * Warm the WASM engine so the user's first Ctrl+Enter doesn't pay the
   * ~120 MB cold start (wasm + TeX Live data packages).
   *
   * The cost is real — loading pushes that much data through the renderer and
   * grows the Emscripten heap by hundreds of MB — so this is gated three ways:
   *
   *   1. **Prior use.** Only projects where a WASM compile has already
   *      succeeded are warmed. A first visit pays the cold start once (with
   *      visible progress); every later session is fast. Users who open a
   *      project to fix a typo and never compile pay nothing.
   *   2. **Explicit engine.** `auto` resolves local-first, so a machine with
   *      TeX Live installed would never touch the WASM engine; CLI engines
   *      have no renderer-side cold start at all.
   *   3. **Timing.** Deferred past the startup storm (Monaco, LSP spawn,
   *      pdf.js) and then queued for a *genuinely* idle moment. The shared
   *      IdleTaskScheduler is not used here: it passes `timeout: 5000` to
   *      requestIdleCallback, which force-runs the task even when the app is
   *      busy — exactly the jank this guard exists to avoid.
   *
   * Only one engine is warmed; holding BusyTeX and typst-ts at once doubles
   * renderer memory for no benefit.
   */
  private _schedulePrewarm(projectPath: string): void {
    if (!hasCompiledWithWasm(projectPath)) return;

    this._prewarmTimer = setTimeout(() => {
      this._prewarmTimer = null;
      const requestIdle = (
        globalThis as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
        }
      ).requestIdleCallback;

      const run = (): void => {
        this._prewarmIdleHandle = null;
        void this._runPrewarm();
      };

      // No `timeout` option: if the app never goes idle, skipping the
      // prewarm is the correct outcome.
      this._prewarmIdleHandle = requestIdle ? requestIdle(run) : null;
      if (!requestIdle) run();
    }, PREWARM_DELAY_MS);
  }

  private async _runPrewarm(): Promise<void> {
    if (this.isCompiling) return;
    const settings = getSettingsService().getSettings().compiler;
    const engine: CompileEngine | null =
      typeof settings.engine === 'string' && settings.engine.startsWith('wasm-')
        ? (settings.engine as CompileEngine)
        : settings.typstEngine === 'wasm-typst'
          ? 'wasm-typst'
          : null;
    if (!engine) return;

    // Provider selection is keyed on the engine id, same as a compile;
    // the filename only has to carry a matching extension.
    const probeFile = engine === 'wasm-typst' ? 'prewarm.typ' : 'prewarm.tex';
    const provider = this._compilerRegistry.getCompilerForFile(probeFile, { engine });
    if (!provider?.prewarm) return;
    logger.info('Prewarming WASM engine', { engine, provider: provider.id });
    await provider.prewarm();
  }

  private _registerBuiltinProviders(): void {
    this._disposables.add(this._compilerRegistry.register(new LaTeXCompilerProvider(), 10));

    this._disposables.add(this._compilerRegistry.register(new TypstCompilerProvider(), 10));

    this._disposables.add(this._compilerRegistry.register(new WASMCompilerProvider(), 8));

    this._disposables.add(this._compilerRegistry.register(new TypstWasmCompilerProvider(), 8));

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

  cancel(): void {
    this._currentProvider?.cancel?.();
  }

  /**
   * Resolve the `auto` engine (local-first) to a concrete engine using the
   * cached capability probe. No-op for any explicit engine selection. Returns
   * whether the result is a local engine so {@link _doCompile} can decide
   * whether a runtime failure warrants the WASM fallback — kept as a return
   * value (not instance state) so it can't leak across compiles.
   */
  private async _resolveAutoEngine(
    options: CompileOptions
  ): Promise<{ options: CompileOptions; autoResolvedLocal: boolean }> {
    if (options.engine !== 'auto') return { options, autoResolvedLocal: false };

    let resolved: string;
    try {
      resolved = resolveAutoLatexEngine(await getLatexCapabilities());
    } catch (error) {
      // Probe failed (e.g. transient IPC error). Don't dead-end the compile —
      // fall back to the always-available WASM engine. getLatexCapabilities
      // clears its cache on rejection so a later compile can retry detection.
      logger.warn('LaTeX capability probe failed; auto falls back to WASM', {
        error: error instanceof Error ? error.message : String(error),
      });
      resolved = AUTO_WASM_FALLBACK;
    }
    this.log('info', `Auto engine resolved to: ${resolved}`);
    return {
      options: { ...options, engine: resolved as CompileEngine },
      autoResolvedLocal: isLocalLatexEngine(resolved),
    };
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
      // Resolve the `auto` engine (local-first) before provider routing —
      // downstream providers only understand concrete engine names.
      const autoResolution = await this._resolveAutoEngine(options);
      options = autoResolution.options;

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

      // Inject the phase observer (dependency inversion: providers see a
      // callback, not this service). Both provider calls below share it.
      const phaseListener = (phase: CompileProgressPayload): void => {
        this._onDidCompilePhase.fire(phase);
      };

      this._currentProvider = provider;
      result = await provider.compile(filePath, content, { ...options, onPhase: phaseListener });
      this._currentProvider = null;

      // `auto` fallback: if the local engine we chose turns out to be missing
      // at runtime, retry once on the WASM engine so a compile never dead-ends
      // on a stale capability probe. Only fires for auto-resolved local runs.
      if (!result.success && autoResolution.autoResolvedLocal && isMissingEngineFailure(result)) {
        this.log(
          'warning',
          `Local engine "${options.engine}" unavailable; falling back to ${AUTO_WASM_FALLBACK} (WASM).`
        );
        const wasmOptions = { ...options, engine: AUTO_WASM_FALLBACK as CompileEngine };
        const wasmProvider = this._compilerRegistry.getCompilerForFile(filePath, wasmOptions);
        if (wasmProvider) {
          this._currentProvider = wasmProvider;
          result = await wasmProvider.compile(filePath, content, {
            ...wasmOptions,
            onPhase: phaseListener,
          });
          this._currentProvider = null;
        }
      }

      result.sourceFile = filePath;
      result.time = Date.now() - startTime;
      // Remember that this project really does compile with a WASM engine —
      // that is what makes it eligible for prewarming next session. Recorded
      // only on success, and only for the engines that have a cold start.
      if (result.success && isWasmEngine(options.engine) && options.projectPath) {
        rememberWasmCompile(options.projectPath);
      }
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
   * Log compile result.
   */
  private logCompileResult(result: CompileResult): void {
    const timeStr = ((result.time || 0) / 1000).toFixed(2);

    if (result.cancelled) {
      this.log('warning', `Compilation cancelled. Time: ${timeStr}s`);
      return;
    }

    if (result.success) {
      this.log('success', `Compilation succeeded! Time: ${timeStr}s`);

      // Prefer showing parsed warnings (with file and line number)
      if (result.parsedWarnings && result.parsedWarnings.length > 0) {
        result.parsedWarnings.forEach((entry) => {
          const msg = this.formatParsedEntry(entry);
          this.log('warning', msg, entry.raw || entry.content || undefined);
        });
      } else if (result.warnings && result.warnings.length > 0) {
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

      // Prefer showing parsed structured errors (with file and line number)
      if (result.parsedErrors && result.parsedErrors.length > 0) {
        result.parsedErrors.forEach((entry) => {
          const msg = this.formatParsedEntry(entry);
          // raw/content provided as details — expandable for the full log context
          this.log('error', msg, entry.raw || entry.content || undefined);
        });
      } else if (result.errors && result.errors.length > 0) {
        // Fall back to raw error strings when parsed results are unavailable
        result.errors.forEach((err) => {
          const msg = this.formatLogEntry(err);
          this.log('error', msg);
        });
      }

      // Show parsed warnings
      if (result.parsedWarnings && result.parsedWarnings.length > 0) {
        result.parsedWarnings.forEach((entry) => {
          const msg = this.formatParsedEntry(entry);
          this.log('warning', msg, entry.raw || entry.content || undefined);
        });
      }

      if (result.log) {
        this.log('info', 'Click to view full log', result.log);
      }
    }
  }

  /**
   * Format log entry as string.
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

  /** Format a parsed log entry as "file:line: message" */
  private formatParsedEntry(entry: {
    file?: string;
    line?: number | null;
    message: string;
  }): string {
    const loc = entry.file ? (entry.line != null ? `${entry.file}:${entry.line}` : entry.file) : '';
    return loc ? `${loc}: ${entry.message}` : entry.message;
  }

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
