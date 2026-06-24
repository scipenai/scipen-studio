/**
 * @file CompilerProviders.ts - Compiler Provider Implementation
 * @description Provides Provider implementations for LaTeX, Typst, Overleaf, and WASM compilers
 * @depends IPC (api.compiler), CompilerRegistry, BusyTexEngine
 */

import { api } from '../../api';
import { t } from '../../locales';
import { createLogger } from '../LogService';
import { BusyTexEngine, type BusyTexEngineType } from '../BusyTexEngine';
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

    const compileOptions: {
      engine?: LatexEngine;
      mainFile?: string;
      projectPath?: string;
    } = {
      engine: options.engine as LatexEngine,
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

      if (!this.engine) {
        const engine = new TypstWasmEngine();
        // Set the font endpoint BEFORE loadEngine — the worker registers all
        // fonts up-front (typst-ts `add_raw_font` is only valid pre-`build()`).
        // Changing the endpoint later requires `engine.close()` + rebuild.
        const settings = getSettingsService().getSettings().compiler;
        engine.setFontEndpoint(settings.typstFontEndpoint || '');
        await engine.loadEngine();
        this.engine = engine;
      }

      // Re-stage the current project tree. typst-ts `add_source` is
      // overwrite-by-path; unchanged sources keep their memoised layout
      // in the incremental cache — DO NOT flushSources() here, that would
      // nuke the cache and turn every compile into a cold compile.
      await this.stageProjectSources(filePath, content, options);

      const mainPath = this.resolveMainPath(filePath, options);
      this.engine.setMainFile(mainPath);

      const output = await this.engine.compile();
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
      // SyncTeX CLI to read; skipping `Compile_WriteWasmArtifacts` avoids
      // creating an empty `.synctex.gz` placeholder.
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
    this.engine?.close();
    this.engine = null;
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

/** File extensions relevant for LaTeX compilation */
const TEX_FILE_EXTENSIONS = /\.(tex|bib|sty|cls|bst|def|cfg|fd|bbl|aux|clo|ldf|ltx|dtx|ins)$/i;

/**
 * Map the public Studio engine name to the BusyTeX engine type.
 * The Studio engine ids stay stable across builds; the BusyTeX driver
 * names live behind {@link BusyTexEngine}.
 */
const WASM_ENGINE_MAP: Record<string, BusyTexEngineType> = {
  'wasm-pdftex': 'pdftex',
  'wasm-xetex': 'xetex',
  'wasm-lualatex': 'lualatex',
};

export class WASMCompilerProvider implements CompilerProvider {
  readonly id = 'busytex-wasm';
  readonly name = 'BusyTeX (WASM)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 8;
  readonly isRemote = false;

  /**
   * Single combined-build engine for the lifetime of the provider. The
   * BusyTeX wasm carries all three drivers (pdftex/xetex/lualatex), so
   * switching engines is a per-compile parameter, not a worker rebuild
   * — see {@link BusyTexEngine}'s class doc.
   */
  private engine: BusyTexEngine | null = null;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const engineType = WASM_ENGINE_MAP[options.engine ?? ''];
    if (!engineType) {
      return {
        success: false,
        errors: [`Unsupported WASM engine: ${options.engine}`],
        log: '',
      };
    }

    logger.info('Starting WASM compile', { engine: engineType, file: filePath });

    try {
      // Lazy-init on first use; commit only after loadEngine() resolves
      // so a failed init doesn't park a non-ready engine in the cache
      // (every retry would then skip init and throw "not ready").
      if (!this.engine) {
        const engine = new BusyTexEngine();
        await engine.loadEngine();
        this.engine = engine;
      }

      const settings = getSettingsService().getSettings().compiler;
      this.engine.setTexliveEndpoint(settings.texliveEndpoint || '');

      // Each compile gets a fresh in-memory FS (BusyTeX semantics);
      // flushWorkDir just resets the renderer-side staging list.
      this.engine.flushWorkDir();

      // Stage project sources into the worker FS.
      const stageT0 = performance.now();
      await this.writeProjectFiles(filePath, content, options);
      logger.info('WASM stage done', {
        stageMs: Math.round(performance.now() - stageT0),
      });

      const mainFileName = this.resolveMainFile(filePath, options);
      this.engine.setMainFile(mainFileName);

      const result = await this.engine.compile({ engineType });

      if (!result.success) {
        return {
          success: false,
          log: result.log,
          errors: this.parseErrors(result.log),
          warnings: this.parseWarnings(result.log),
        };
      }

      // Persist the WASM output (PDF + .synctex.gz) to a temp dir so the
      // rest of the pipeline treats it exactly like a CLI compile: the PDF
      // is loaded from `pdfPath` and SyncTeX resolves via the main-process
      // `synctex` CLI against the on-disk `.synctex.gz`. This disk handoff
      // is the canonical (and only) output path — a failure here is a real
      // error and propagates to the outer catch.
      const baseName = stripExtension(basename(mainFileName)) || 'main';
      const writeT0 = performance.now();
      const artifacts = await api.compile.writeWasmArtifacts(
        result.pdf!,
        result.synctex ?? new Uint8Array(),
        baseName
      );
      logger.info('WASM artifacts persisted', {
        writeMs: Math.round(performance.now() - writeT0),
      });

      return {
        success: true,
        pdfPath: artifacts.pdfPath,
        synctexPath: result.synctex ? artifacts.synctexPath : undefined,
        projectRoot: options.projectPath,
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
    return options?.engine !== undefined && options.engine in WASM_ENGINE_MAP;
  }

  /**
   * Stage all project sources into the worker FS. Current file uses the
   * (possibly unsaved) editor content; siblings are batch-read from disk.
   * Paths are project-relative so BusyTeX reconstructs the source tree;
   * parent directories are created implicitly by the virtual filesystem.
   */
  private async writeProjectFiles(
    currentFilePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<void> {
    const engine = this.engine!;
    const projectPath = options.projectPath;
    const currentRelativePath = this.toWasmRelativePath(currentFilePath, projectPath);

    await engine.writeFile(currentRelativePath, content);

    if (!projectPath) return;

    const scanResult = await api.file.scanFilePaths(projectPath);
    if (!scanResult.success || !scanResult.paths) return;

    const texFiles = scanResult.paths.filter((p) => TEX_FILE_EXTENSIONS.test(p));
    if (texFiles.length === 0) return;

    const batchResult = await api.file.batchRead(texFiles);

    for (const [absolutePath, fileContent] of Object.entries(batchResult)) {
      const relativePath = this.toWasmRelativePath(absolutePath, projectPath);
      if (relativePath === currentRelativePath) continue;
      await engine.writeFile(relativePath, fileContent);
    }
  }

  private resolveMainFile(filePath: string, options: CompilerOptions): string {
    const mainFilePath = options.mainFile || filePath;
    return this.toWasmRelativePath(mainFilePath, options.projectPath);
  }

  private toWasmRelativePath(filePath: string, projectPath?: string): string {
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

  cancel(): void {
    this.engine?.close();
    this.engine = null;
  }
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}
