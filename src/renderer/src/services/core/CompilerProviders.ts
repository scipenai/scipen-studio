/**
 * @file CompilerProviders.ts - Compiler Provider Implementation
 * @description Provides Provider implementations for LaTeX, Typst, Overleaf, and WASM compilers
 * @depends IPC (api.compiler), CompilerRegistry, StellarLatexEngine
 */

import { api } from '../../api';
import { createLogger } from '../LogService';
import { StellarLatexEngine } from '../StellarLatexEngine';
import { getSyncTeXService } from '../SyncTeXService';
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

    // Clear WASM engine for traditional compilation
    const syncTeXService = getSyncTeXService();
    syncTeXService.setWASMEngine(null);

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
    if (options?.engine === 'wasm-pdftex' || options?.engine === 'wasm-xetex') {
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

// ====== WASM Compiler Provider (StellarLatex) ======

/** File extensions relevant for LaTeX compilation */
const TEX_FILE_EXTENSIONS = /\.(tex|bib|sty|cls|bst|def|cfg|fd|bbl|aux|clo|ldf|ltx|dtx|ins)$/i;

export class WASMCompilerProvider implements CompilerProvider {
  readonly id = 'stellar-wasm';
  readonly name = 'StellarLatex (WASM)';
  readonly supportedExtensions = ['tex', 'latex', 'ltx'];
  readonly priority = 8;
  readonly isRemote = false;

  private engine: StellarLatexEngine | null = null;
  private currentEngineType: 'pdftex' | 'xetex' | null = null;

  async compile(
    filePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<CompileResult> {
    const engineType = options.engine === 'wasm-pdftex' ? 'pdftex' : 'xetex';

    logger.info('Starting WASM compile', {
      engine: engineType,
      file: filePath,
    });

    try {
      // Initialize or reuse engine
      if (!this.engine || this.currentEngineType !== engineType) {
        this.engine?.close();
        this.engine = new StellarLatexEngine(engineType);
        this.currentEngineType = engineType;
        await this.engine.loadEngine();
      }

      // Apply the user-configured TexLive package endpoint
      const texliveEndpoint = getSettingsService().getSettings().compiler.texliveEndpoint;
      if (texliveEndpoint) {
        this.engine.setTexliveEndpoint(texliveEndpoint);
      }

      // Clean previous compilation state
      this.engine.flushWorkDir();
      this.engine.flushBuild();

      // Write project files to WASM virtual filesystem
      await this.writeProjectFiles(filePath, content, options);

      // Set main file and compile
      const mainFileName = this.resolveMainFile(filePath, options);
      this.engine.setMainFile(mainFileName);

      const result = await this.engine.compile();

      // Set WASM engine for SyncTeX if compilation succeeded
      if (result.success && result.synctex) {
        const syncTeXService = getSyncTeXService();
        syncTeXService.setWASMEngine(this.engine);
      }

      return {
        success: result.success,
        pdfBuffer: result.pdf,
        synctexBuffer: result.synctex,
        log: result.log,
        errors: result.success ? undefined : this.parseErrors(result.log),
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
    return options?.engine === 'wasm-pdftex' || options?.engine === 'wasm-xetex';
  }

  /**
   * Write all project files to the WASM virtual filesystem.
   * Current file uses the provided content (may be unsaved).
   * Other files are read via IPC batch read.
   */
  private async writeProjectFiles(
    currentFilePath: string,
    content: string,
    options: CompilerOptions
  ): Promise<void> {
    const engine = this.engine!;
    const projectPath = options.projectPath;
    const currentRelativePath = this.toWasmRelativePath(currentFilePath, projectPath);
    const createdDirs = new Set<string>();

    await this.ensureParentDirectories(engine, currentRelativePath, createdDirs);
    engine.registerPathMapping(currentFilePath, currentRelativePath);
    await engine.writeFile(currentRelativePath, content);

    if (!projectPath) return;

    try {
      const scanResult = await api.file.scanFilePaths(projectPath);
      if (!scanResult.success || !scanResult.paths) return;

      const texFiles = scanResult.paths.filter((p) => TEX_FILE_EXTENSIONS.test(p));
      if (texFiles.length === 0) return;

      const batchResult = await api.file.batchRead(texFiles);

      for (const [absolutePath, fileContent] of Object.entries(batchResult)) {
        const relativePath = this.toWasmRelativePath(absolutePath, projectPath);

        if (relativePath === currentRelativePath) continue;

        await this.ensureParentDirectories(engine, relativePath, createdDirs);
        engine.registerPathMapping(absolutePath, relativePath);
        await engine.writeFile(relativePath, fileContent);
      }
    } catch (error) {
      logger.warn('Failed to read project files for WASM compilation', { error });
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

  private async ensureParentDirectories(
    engine: StellarLatexEngine,
    relativePath: string,
    createdDirs: Set<string>
  ): Promise<void> {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    if (parts.length <= 1) return;

    let dirPath = '';
    for (let index = 0; index < parts.length - 1; index++) {
      dirPath = dirPath ? `${dirPath}/${parts[index]}` : parts[index];
      if (createdDirs.has(dirPath)) continue;
      await engine.mkdir(dirPath);
      createdDirs.add(dirPath);
    }
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
  }
}
