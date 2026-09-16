/**
 * @file CompilerProviders.ts - Compiler Provider Implementation
 * @description Provides Provider implementations for LaTeX, Typst, Overleaf, and WASM compilers
 * @depends IPC (api.compiler), CompilerRegistry, BusyTexEngine
 */

import { api } from '../../api';
import { DEFAULT_TEXLIVE_ENDPOINT } from '../../constants/latex';
import { t } from '../../locales';
import { createLogger } from '../LogService';
import { TypstWasmEngine } from '../TypstWasmEngine';
import { getSettingsService } from './ServiceRegistry';
import type { CompileResult, LatexEngine, TypstEngine } from './CompileService';
import type { CompilerOptions, CompilerProvider } from './LanguageFeatureRegistry';

const logger = createLogger('CompilerProviders');

// ====== LaTeX Compiler Provider ======

export class LaTeXCompilerProvider implements CompilerProvider {
  readonly id = 'latex-local';
  readonly name = 'LaTeX (Local)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 10;
  readonly isRemote = false;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    logger.info('Starting local LaTeX compile', {
      engine: options.engine,
      file: filePath,
    });

    // `auto` is resolved to a concrete engine by CompileService before routing,
    // so it never reaches this provider — narrow it out for the IPC contract.
    const compileOptions: {
      engine?: Exclude<LatexEngine, 'auto'>;
      mainFile?: string;
      projectPath?: string;
    } = {
      engine: options.engine as Exclude<LatexEngine, 'auto'>,
    };

    if (options.mainFile) {
      compileOptions.mainFile = options.mainFile;
    }

    const result = await api.compile.latex(content, compileOptions);

    return {
      success: result.success,
      pdfPath: result.pdfPath,
      synctexPath: result.synctexPath,
      log: result.log,
      errors: result.errors,
      warnings: result.warnings,
      parsedErrors: result.parsedErrors as Array<{ line: number; message: string }> | undefined,
      parsedWarnings: result.parsedWarnings as Array<{ line: number; message: string }> | undefined,
      parsedInfo: result.parsedInfo as Array<{ line: number; message: string }> | undefined,
    };
  }

  canHandle(filePath: string, options?: CompilerOptions): boolean {
    // Exclude WASM engines
    if (
      options?.engine === 'wasm-pdftex' ||
      options?.engine === 'wasm-xetex' ||
      options?.engine === 'wasm-lualatex'
    ) {
      return false;
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return this.supportedExtensions.includes(ext);
  }
}

// ====== Typst Compiler Provider ======

export class TypstCompilerProvider implements CompilerProvider {
  readonly id = 'typst-local';
  readonly name = 'Typst (Local)';
  readonly supportedExtensions = ['typ'];
  readonly priority = 10;
  readonly isRemote = false;

  /**
   * Owns ONLY the CLI engines. `wasm-typst` is routed to
   * {@link TypstWasmCompilerProvider} so a missing CLI binary doesn't
   * masquerade as a WASM failure (and vice versa).
   */
  canHandle(filePath: string, options?: CompilerOptions): boolean {
    if (options?.engine === 'wasm-typst') {
      return false;
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return this.supportedExtensions.includes(ext);
  }

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const typstEngine =
      options.engine === 'typst' || options.engine === 'tinymist'
        ? (options.engine as TypstEngine)
        : 'tinymist';

    logger.info('Starting Typst compile', {
      engine: typstEngine,
      file: filePath,
    });

    const compileOptions: {
      engine?: TypstEngine;
      mainFile?: string;
      projectPath?: string;
    } = {
      engine: typstEngine,
    };

    if (options.mainFile) {
      compileOptions.mainFile = options.mainFile;
    }

    const result = await api.compile.typst(content, compileOptions);

    return {
      success: result.success,
      pdfPath: result.pdfPath,
      synctexPath: (result as { synctexPath?: string }).synctexPath,
      log: result.log,
      errors: result.errors,
      warnings: result.warnings,
      parsedErrors: result.parsedErrors as Array<{ line: number; message: string }> | undefined,
      parsedWarnings: result.parsedWarnings as Array<{ line: number; message: string }> | undefined,
      parsedInfo: result.parsedInfo as Array<{ line: number; message: string }> | undefined,
    };
  }
}

// ====== Typst WASM Compiler Provider (typst-ts) ======

/** File extensions the Typst WASM engine reads. */
const TYPST_FILE_EXTENSIONS = /\.typ$/i;

/**
 * Provider for the in-renderer typst.ts WASM compiler.
 *
 * Why a dedicated Provider (instead of an `engine` branch inside
 * `TypstCompilerProvider`)?
 *   - The CLI path round-trips through main-process IPC; the WASM path
 *     stays entirely in the renderer. Mixing them would force every
 *     compile through the IPC `Compile_Typst` schema even when the wasm
 *     engine is in use.
 *   - Capability-detection UI needs to advertise CLI and WASM availability
 *     independently (`Typst_GetCapabilities`). Two providers map 1:1.
 *   - Mirrors the LaTeX side: {@link WASMCompilerProvider} co-exists with
 *     {@link LaTeXCompilerProvider} the same way.
 *
 * Differences from {@link WASMCompilerProvider}:
 *   - typst-ts does NOT emit a `.synctex.gz` (Typst has no SyncTeX —
 *     jump-to-source lives in the LSP/preview layer upstream). The
 *     provider returns the PDF as a `pdfBuffer` directly; `useCompilation`
 *     already supports buffer-only results.
 *   - No project-relative path rewriting against MEMFS: typst-ts uses a
 *     plain virtual filesystem rooted at `/` so paths translate directly.
 */
export class TypstWasmCompilerProvider implements CompilerProvider {
  readonly id = 'typst-wasm';
  readonly name = 'Typst.ts (WASM)';
  readonly supportedExtensions = ['typ'];
  readonly priority = 8;
  readonly isRemote = false;

  /**
   * Lazy single engine for the provider lifetime. Init cost (~500ms) is
   * paid on the first compile and amortised across the session.
   * See {@link TypstWasmEngine} doc for the recycling story.
   */
  private engine: TypstWasmEngine | null = null;
  /**
   * In-flight `loadEngine()` shared by compile and prewarm — same
   * double-construction guard as {@link WASMCompilerProvider.acquireEngine}.
   */
  private enginePromise: Promise<TypstWasmEngine> | null = null;
  /** Bumped per load attempt and by cancel(); see acquireEngine's finally. */
  private loadGeneration = 0;

  /** Load at most once across concurrent callers; retryable after failure. */
  private async acquireEngine(): Promise<TypstWasmEngine> {
    if (this.engine) return this.engine;
    if (this.enginePromise) return this.enginePromise;

    // Generation stamp — see WASMCompilerProvider.acquireEngine.
    const generation = ++this.loadGeneration;
    const promise = (async () => {
      try {
        const engine = new TypstWasmEngine();
        // Set the font endpoint BEFORE loadEngine — the worker registers all
        // fonts up-front (typst-ts `add_raw_font` is only valid pre-`build()`).
        // Changing the endpoint later requires `engine.close()` + rebuild.
        const settings = getSettingsService().getSettings().compiler;
        engine.setFontEndpoint(settings.typstFontEndpoint || '');
        await engine.loadEngine();
        this.engine = engine;
        return engine;
      } finally {
        if (this.loadGeneration === generation) this.enginePromise = null;
      }
    })();
    this.enginePromise = promise;
    return promise;
  }

  /** Warm the typst-ts worker off the first-compile hot path. Never throws. */
  async prewarm(): Promise<void> {
    try {
      await this.acquireEngine();
    } catch {
      // Intentionally silent — the real compile reports engine failures.
    }
  }

  /**
   * Compile counter for memory-pressure recycling. typst-ts's incremental
   * compiler accumulates layout state (typst#334) — in a long session this
   * climbs to multi-GB. Hard cap: after this many compiles the engine is
   * closed and the next compile pays the cold-init cost (~500ms) again.
   *
   * 50 is a compromise: typical 5-page papers compile every ~100ms during
   * active editing, so 50 compiles ≈ 5-10 min of busy editing. Long enough
   * that users don't notice the periodic re-init, short enough that the
   * cache never grows beyond a few hundred MB.
   */
  private static readonly RECYCLE_THRESHOLD = 50;
  private compileCount = 0;

  canHandle(_filePath: string, options?: CompilerOptions): boolean {
    return options?.engine === 'wasm-typst';
  }

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    logger.info('Starting Typst WASM compile', {
      file: filePath,
      compileCount: this.compileCount,
    });

    try {
      // Hit the recycle threshold → close engine before the next compile
      // re-inits. Doing this BEFORE the lazy-init check below means the
      // cold-start path is taken automatically.
      if (this.engine && this.compileCount >= TypstWasmCompilerProvider.RECYCLE_THRESHOLD) {
        logger.info('Typst WASM engine recycled (compileCount threshold reached)', {
          threshold: TypstWasmCompilerProvider.RECYCLE_THRESHOLD,
        });
        this.engine.close();
        this.engine = null;
        this.compileCount = 0;
      }

      // Engine load is shared with prewarm — see acquireEngine().
      const engine = await this.acquireEngine();

      // Re-stage the current project tree. typst-ts `add_source` is
      // overwrite-by-path; unchanged sources keep their memoised layout
      // in the incremental cache — DO NOT flushSources() here, that would
      // nuke the cache and turn every compile into a cold compile.
      await this.stageProjectSources(filePath, content, options);

      const mainPath = this.resolveMainPath(filePath, options);
      engine.setMainFile(mainPath);

      const output = await engine.compile();
      this.compileCount += 1;

      const errorDiags = output.diagnostics.filter((d) => d.severity === 1);
      const warningDiags = output.diagnostics.filter((d) => d.severity === 2);

      const parsedErrors = errorDiags.map((d) => ({
        line: d.range.start.line + 1,
        message: d.message,
      }));
      const parsedWarnings = warningDiags.map((d) => ({
        line: d.range.start.line + 1,
        message: d.message,
      }));

      // Font-related diagnostic? Attach a hint tailored to the user's
      // endpoint state so they know exactly what to do (configure / fix
      // URL / edit manifest). We append rather than replace so the raw
      // typst diagnostic stays visible for debugging.
      const fontHint = this.buildFontHint(output.diagnostics);
      if (fontHint) {
        parsedErrors.push({ line: 0, message: fontHint });
      }

      const log = [
        ...output.diagnostics.map(
          (d) =>
            `${d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info'}: ${d.message}`
        ),
        ...(fontHint ? [fontHint] : []),
      ].join('\n');

      // `pdfBuffer` is consumed directly by useCompilation — no disk I/O
      // round-trip. typst-ts has no synctex so there's nothing for the
      // SyncTeX CLI to read; no `.synctex.gz` placeholder is created.
      return {
        success: output.success,
        pdfBuffer: output.pdf,
        log,
        errors: parsedErrors.map((e) => e.message),
        warnings: parsedWarnings.map((w) => w.message),
        parsedErrors,
        parsedWarnings,
        parsedInfo: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Typst WASM compile failed', { error: message });
      return {
        success: false,
        errors: [message],
        log: message,
        parsedErrors: [{ line: 0, message }],
      };
    }
  }

  cancel(): void {
    // Recycle the engine on cancel. typst-ts has no in-flight-cancel API
    // (the compile call is a single wasm invocation that runs to
    // completion); terminating the worker is the only way to stop it.
    // The next compile pays the cold-init cost (~500ms) again.
    this.loadGeneration += 1;
    this.engine?.close();
    this.engine = null;
    this.enginePromise = null;
    this.compileCount = 0;
  }

  /**
   * If any compile diagnostic mentions a font, pick the hint that matches
   * the engine's font-loading state at last init. typst-ts can't add fonts
   * post-build, so the action is always "fix config, restart engine" —
   * this just makes that specific fix discoverable.
   *
   * Returns the localised hint string, or null when no font diagnostic
   * is present.
   */
  private buildFontHint(diagnostics: { severity: number; message: string }[]): string | null {
    if (!this.engine) return null;
    const fontMentioned = diagnostics.some((d) => d.severity === 1 && /font/i.test(d.message));
    if (!fontMentioned) return null;
    const ctx = this.engine.fontContext;
    if (!ctx.endpointConfigured) {
      return t('compiler.typstFontHintNotConfigured');
    }
    if (!ctx.endpointReachable) {
      return t('compiler.typstFontHintFetchFailed');
    }
    return t('compiler.typstFontHintConfigured');
  }

  /**
   * Stage the current document + every other `.typ` file in the project
   * so cross-file `#import` references resolve. Mirrors
   * {@link WASMCompilerProvider.writeProjectFiles} but with the simpler
   * typst-ts virtual-fs path conventions.
   */
  private async stageProjectSources(
    currentFilePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<void> {
    const engine = this.engine!;
    const projectPath = options.projectPath;
    const currentRelativePath = this.toVfsPath(currentFilePath, projectPath);

    // writeFile is renderer-side sync — no IPC, no await. The whole source
    // table is shipped in one batch at engine.compile() time.
    engine.writeFile(currentRelativePath, content);

    if (!projectPath) return;

    const scanResult = await api.file.scanFilePaths(projectPath);
    if (!scanResult.success || !scanResult.paths) return;

    const typFiles = scanResult.paths.filter((p) => TYPST_FILE_EXTENSIONS.test(p));
    if (typFiles.length === 0) return;

    const batchResult = await api.file.batchRead(typFiles);

    for (const [absolutePath, fileContent] of Object.entries(batchResult)) {
      const relativePath = this.toVfsPath(absolutePath, projectPath);
      if (relativePath === currentRelativePath) continue;
      engine.writeFile(relativePath, fileContent);
    }
  }

  private resolveMainPath(filePath: string, options: CompilerOptions): string {
    const mainFilePath = options.mainFile || filePath;
    return this.toVfsPath(mainFilePath, options.projectPath);
  }

  /**
   * Convert a host absolute path to a typst-ts virtual-fs path with a
   * leading `/`. Paths outside the project root fall back to their
   * basename, matching {@link WASMCompilerProvider.toWasmRelativePath}.
   */
  private toVfsPath(filePath: string, projectPath?: string): string {
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedProjectPath = projectPath?.replace(/\\/g, '/').replace(/\/$/, '');

    if (normalizedProjectPath && normalizedFilePath.startsWith(`${normalizedProjectPath}/`)) {
      return `/${normalizedFilePath.slice(normalizedProjectPath.length + 1)}`;
    }

    return `/${normalizedFilePath.split('/').pop() || 'main.typ'}`;
  }
}

// ====== WASM Compiler Provider (BusyTeX) ======

/**
 * Map the public Studio engine name to the BusyTeX driver. The engine itself
 * is a combined build — the driver is a per-compile parameter.
 */
/** Extensions staged from the project directory for compilation. */
const TEX_FILE_EXTENSIONS = /\.(tex|bib|sty|cls|bst|def|cfg|fd|bbl|aux|clo|ldf|ltx|dtx|ins)$/i;

/** Graphics files staged as BINARY (base64 over the wire) so xdvipdfmx
 *  embeds the real images instead of failing on missing files. */
const GRAPHICS_FILE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|pdf)$/i;
const MAX_BINARY_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STAGED_BINARY_TOTAL_BYTES = 128 * 1024 * 1024;

const BUSYTEX_DRIVER_MAP: Record<string, string> = {
  'wasm-pdftex': 'pdftex_bibtex8',
  'wasm-xetex': 'xetex_bibtex8_dvipdfmx',
  'wasm-lualatex': 'luahbtex_bibtex8',
};

/**
 * Provider for the BusyTeX engine, which runs in a dedicated Electron
 * UtilityProcess (see `src/main/busytex-process/`).
 *
 * Responsibilities split at the process boundary:
 *   - THIS side (renderer): stages the file set — the current buffer comes
 *     from Monaco, siblings are batch-read from disk — and maps the result.
 *   - THE ENGINE side (utility): runs the pipeline and writes the PDF and
 *     `.synctex.gz` straight into the project directory, so the artifact
 *     never crosses an IPC boundary and the Emscripten heap never grows in
 *     the renderer.
 *
 * Phases: staging is emitted here; pass/package phases are parsed from the
 * engine's stdout prints in the main process and arrive via
 * `Compile_Progress` (CompileService merges them into the same stream).
 */
export class WASMCompilerProvider implements CompilerProvider {
  readonly id = 'busytex-wasm';
  readonly name = 'BusyTeX (WASM)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 8;
  readonly isRemote = false;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const driver = BUSYTEX_DRIVER_MAP[options.engine ?? ''];
    if (!driver) {
      return {
        success: false,
        errors: [`Unsupported WASM engine: ${options.engine}`],
        log: '',
      };
    }

    logger.info('Starting WASM compile', { engine: options.engine, file: filePath });

    const emitPhase = (stage: 'staging', message: string): void => {
      options.onPhase?.({ engine: 'latex', stage, message });
    };

    try {
      // Stage the file set: the current file from the editor buffer (it may
      // hold unsaved changes), siblings verbatim from disk.
      emitPhase('staging', 'Staging project files');
      const stageT0 = performance.now();
      const files = await this.stageFiles(filePath, content, options);
      logger.info('WASM stage done', {
        stageMs: Math.round(performance.now() - stageT0),
        files: files.length,
      });

      const mainFileAbs = options.mainFile || filePath;
      const mainFile = this.toStagedName(mainFileAbs, options.projectPath);
      const baseName = stripExtension(basename(mainFile)) || 'main';

      const settings = getSettingsService().getSettings().compiler;
      // Fall back to the default endpoint when the setting is blank. A fresh
      // install ships the default, so an empty value almost always means the
      // field got cleared by accident — and with no endpoint, WASM CJK dies
      // with "ctex.sty not found". Defaulting keeps it working.
      const endpoint = settings.texliveEndpoint?.trim() || DEFAULT_TEXLIVE_ENDPOINT;

      const result = await api.compile.busyTeXCompile({
        files,
        mainFile,
        driver,
        endpoint,
        outputDir: dirname(mainFileAbs),
        baseName,
      });

      if (result.cancelled) {
        // Stop button / engine teardown — neutral outcome, not a failure.
        logger.info('WASM compilation cancelled');
        return { success: false, cancelled: true, errors: [], log: '' };
      }

      if (!result.success) {
        return {
          success: false,
          log: result.log,
          errors: result.errors.length > 0 ? result.errors : this.parseErrors(result.log),
          warnings: this.parseWarnings(result.log),
        };
      }

      return {
        success: true,
        pdfPath: result.pdfPath,
        synctexPath: result.synctexPath,
        log: result.log,
        warnings: this.parseWarnings(result.log),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('WASM compilation failed', { error: message });
      return {
        success: false,
        errors: [message],
        log: message,
      };
    }
  }

  canHandle(_filePath: string, options?: CompilerOptions): boolean {
    return options?.engine !== undefined && options.engine in BUSYTEX_DRIVER_MAP;
  }

  /** Warm the engine process (loads wasm + data packages off the hot path). */
  async prewarm(): Promise<void> {
    try {
      await api.compile.busyTeXPrepare();
    } catch {
      // Intentionally silent — a failed prewarm must stay invisible and let
      // the real compile surface the problem.
    }
  }

  cancel(): void {
    // Fire-and-forget: the engine process is torn down; a compile in flight
    // rejects and surfaces as a neutral "cancelled" result.
    void api.compile.busyTeXCancel();
  }

  /**
   * Build the staged file set. Current file uses the (possibly unsaved)
   * editor content; siblings are batch-read from disk. Paths are staged
   * names (project-relative) so BusyTeX reconstructs the source tree.
   */
  private async stageFiles(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<Array<{ path: string; contents: string; encoding?: 'utf8' | 'base64' }>> {
    const files: Array<{ path: string; contents: string; encoding?: 'utf8' | 'base64' }> = [];
    const currentRelativePath = this.toStagedName(filePath, options.projectPath);
    files.push({ path: currentRelativePath, contents: content });

    const projectPath = options.projectPath;
    if (!projectPath) return files;

    const scanResult = await api.file.scanFilePaths(projectPath);
    if (!scanResult.success || !scanResult.paths) return files;

    const texFiles = scanResult.paths.filter((p) => TEX_FILE_EXTENSIONS.test(p));
    if (texFiles.length === 0) return files;

    const batchResult = await api.file.batchRead(texFiles);
    for (const [absolutePath, fileContent] of Object.entries(batchResult)) {
      const relativePath = this.toStagedName(absolutePath, projectPath);
      if (relativePath === currentRelativePath) continue;
      files.push({ path: relativePath, contents: fileContent });
    }

    // Figures and other graphics: staged as base64 so the engine embeds the
    // real bytes. Capped per file and in total — a mis-scanned huge PDF must
    // not blow up the IPC payload.
    const graphicsFiles = scanResult.paths.filter((p) => GRAPHICS_FILE_EXTENSIONS.test(p));
    if (graphicsFiles.length > 0) {
      let stagedBinaryBytes = 0;
      let stagedBinaryCount = 0;
      for (const [absolutePath, base64] of Object.entries(
        await api.file.batchReadBinary(graphicsFiles)
      )) {
        const decodedBytes = (base64.length * 3) / 4;
        if (decodedBytes > MAX_BINARY_FILE_BYTES) {
          logger.warn('Skipping oversized graphic', { absolutePath, decodedBytes });
          continue;
        }
        if (stagedBinaryBytes + decodedBytes > MAX_STAGED_BINARY_TOTAL_BYTES) {
          logger.warn('Staged binary budget exhausted — remaining graphics skipped', {
            stagedBinaryBytes,
          });
          break;
        }
        stagedBinaryBytes += decodedBytes;
        stagedBinaryCount += 1;
        files.push({
          path: this.toStagedName(absolutePath, projectPath),
          contents: base64,
          encoding: 'base64',
        });
      }
      if (stagedBinaryBytes > 0) {
        logger.info('Staged binary graphics', { count: stagedBinaryCount, stagedBinaryBytes });
      }
    }

    return files;
  }

  /** Project-relative staged name; paths outside the project fall back to
   *  their basename (same convention the engine's VFS expects). */
  private toStagedName(filePath: string, projectPath?: string): string {
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedProjectPath = projectPath?.replace(/\\/g, '/').replace(/\/$/, '');

    if (normalizedProjectPath && normalizedFilePath.startsWith(`${normalizedProjectPath}/`)) {
      return normalizedFilePath.slice(normalizedProjectPath.length + 1);
    }

    return normalizedFilePath.split('/').pop() || 'main.tex';
  }

  private parseErrors(log: string): string[] {
    const errors: string[] = [];
    const lines = log.split('\n');
    for (const line of lines) {
      if (line.startsWith('!') || line.includes('Fatal error')) {
        errors.push(line.trim());
      }
    }
    return errors.length > 0 ? errors : ['Compilation failed'];
  }

  private parseWarnings(log: string): string[] {
    const warnings: string[] = [];
    const lines = log.split('\n');
    for (const line of lines) {
      if (line.includes('Warning:') || line.includes('Underfull') || line.includes('Overfull')) {
        warnings.push(line.trim());
      }
    }
    return warnings;
  }
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function dirname(p: string): string {
  const idx = p.replace(/\\/g, '/').lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) || '/' : '.';
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}
