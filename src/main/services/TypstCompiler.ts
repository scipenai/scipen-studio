/**
 * @file TypstCompiler - Typst document compiler
 * @description Compiles Typst documents to PDF using tinymist or typst CLI
 * @implements ICompiler
 */

import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { augmentedEnv } from '../utils/shellEnv';
import { createLogger } from './LoggerService';
import type {
  CompileLogEntry,
  CompileOptions,
  CompileProgress,
  CompileResult,
  ICompiler,
} from './compiler/interfaces';
import fs from './knowledge/utils/fsCompat';

const logger = createLogger('TypstCompiler');

// ====== Environment Detection ======

function isPackaged(): boolean {
  try {
    const { app } = require('electron');
    if (app && typeof app.isPackaged === 'boolean') {
      return app.isPackaged;
    }
  } catch {
    // May be in non-standard environment
  }
  return !!(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function getAppPath(): string {
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      return app.getAppPath();
    }
  } catch {
    // May be in non-standard environment
  }
  return path.resolve(__dirname, '../../..');
}

// ============ Legacy Types (backwards compatibility) ============

/**
 * @deprecated Use CompileOptions from './compiler/interfaces' instead
 */
export interface TypstCompilationOptions {
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
  format?: 'pdf' | 'png' | 'svg';
}

/**
 * @deprecated Use CompileResult from './compiler/interfaces' instead
 */
export interface TypstCompilationResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: string;
  pdfBuffer?: Uint8Array;
  errors?: string[];
  warnings?: string[];
  log?: string;
  time?: number;
}

// ============ Constants ============

/** Max output buffer size (bytes) - prevents memory overflow */
const MAX_OUTPUT_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB

/** Default compile timeout (ms) */
const DEFAULT_COMPILE_TIMEOUT = 60 * 1000;

/** Max compile timeout (ms) */
const MAX_COMPILE_TIMEOUT = 5 * 60 * 1000;

// ============ Main Compiler Class ============

export class TypstCompiler extends EventEmitter implements ICompiler {
  // ================= ICompiler Properties =================

  readonly id = 'typst-local';
  readonly name = 'Local Typst';
  readonly extensions = ['.typ'];
  readonly engines = ['typst', 'tinymist'];
  readonly isRemote = false;

  // ================= Internal State =================

  private tempDir: string;
  private _isCompiling = false;
  private _currentProcess: ReturnType<typeof spawn> | null = null;
  private _timeoutHandle: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.tempDir = path.join(os.tmpdir(), 'scipen-studio-typst');
  }

  // ================= ICompiler Methods =================

  async isAvailable(): Promise<boolean> {
    const executable = await this.findExecutable('tinymist');
    if (executable) return true;
    const typstExec = await this.findExecutable('typst');
    return typstExec !== null;
  }

  async getVersion(): Promise<string | null> {
    for (const engine of ['tinymist', 'typst'] as const) {
      const executable = await this.findExecutable(engine);
      if (!executable) continue;

      return new Promise((resolve) => {
        execFile(executable, ['--version'], { env: augmentedEnv }, (error, stdout) => {
          if (error) {
            resolve(null);
          } else {
            const match = stdout.match(/(\d+\.\d+\.\d+)/);
            resolve(match ? match[1] : stdout.trim());
          }
        });
      });
    }
    return null;
  }

  async getAvailableEngines(): Promise<
    Array<{ engine: string; available: boolean; version?: string }>
  > {
    const results = await Promise.all(
      this.engines.map(async (engine) => {
        const executable = await this.findExecutable(engine as 'typst' | 'tinymist');
        if (!executable) {
          return { engine, available: false };
        }

        return new Promise<{ engine: string; available: boolean; version?: string }>((resolve) => {
          execFile(executable, ['--version'], { env: augmentedEnv }, (error, stdout) => {
            if (error) {
              resolve({ engine, available: false });
            } else {
              const match = stdout.match(/(\d+\.\d+\.\d+)/);
              resolve({ engine, available: true, version: match ? match[1] : stdout.trim() });
            }
          });
        });
      })
    );
    return results;
  }

  async compile(content: string | null, options?: CompileOptions): Promise<CompileResult> {
    if (this._isCompiling) {
      return {
        success: false,
        errors: ['Compilation already in progress'],
        warnings: [],
      };
    }

    this._isCompiling = true;
    const startTime = Date.now();
    const engine = (options?.engine as 'typst' | 'tinymist') || 'tinymist';
    const mainFile = options?.mainFile;
    const timeout = this.getTimeout(options);

    this.emit('start', { mainFile: mainFile || 'untitled.typ', options: options || {} });
    this.emit('progress', { percent: 0, stage: 'Starting compilation' } as CompileProgress);

    try {
      logger.info(
        `[TypstCompiler] compile called with mainFile: ${mainFile}, engine: ${engine}, timeout: ${timeout}ms`
      );

      await fs.ensureDir(this.tempDir);

      const compilationPromise = this.doCompile(content, mainFile, engine, startTime);
      const timeoutPromise = this.createTimeoutPromise(timeout);
      const legacyResult = await Promise.race([compilationPromise, timeoutPromise]);

      const duration = Date.now() - startTime;

      // Convert to ICompiler result format
      const result: CompileResult = {
        success: legacyResult.success,
        outputPath: legacyResult.pdfPath,
        outputData: legacyResult.pdfData,
        outputBuffer: legacyResult.pdfBuffer,
        errors: legacyResult.errors || [],
        warnings: legacyResult.warnings || [],
        log: legacyResult.log,
        duration,
      };

      this.emit('progress', { percent: 100, stage: 'Complete' } as CompileProgress);
      this.emit('complete', result);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const result: CompileResult = {
        success: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        duration,
      };
      this.emit('complete', result);
      return result;
    } finally {
      this.clearTimeout();
      this._isCompiling = false;
      this._currentProcess = null;
    }
  }

  private async doCompile(
    content: string | null,
    mainFile: string | undefined,
    engine: 'typst' | 'tinymist',
    startTime: number
  ): Promise<TypstCompilationResult> {
    let legacyResult: TypstCompilationResult;

    if (mainFile && (await fs.pathExists(mainFile))) {
      logger.info('[TypstCompiler] Using project file compilation');
      legacyResult = await this.compileProjectFile(content || '', mainFile, engine, startTime);
    } else {
      logger.info('[TypstCompiler] Using temp file compilation');
      legacyResult = await this.compileTempFile(content || '', engine, startTime);
    }

    return legacyResult;
  }

  private createTimeoutPromise(timeout: number): Promise<TypstCompilationResult> {
    return new Promise((resolve) => {
      this._timeoutHandle = setTimeout(() => {
        logger.error(`[TypstCompiler] Compilation timeout (${timeout}ms)`);

        if (this._currentProcess) {
          try {
            this._currentProcess.kill('SIGTERM');
          } catch {
            // Ignore kill error
          }
        }

        resolve({
          success: false,
          errors: [
            `Compilation timeout (${timeout / 1000}s).`,
            'Possible reasons:',
            '  1. Typst document has complex computations or infinite loop',
            '  2. Missing required fonts or resources',
            '  3. Compiler waiting for external input',
            'Please check the document and try again.',
          ],
        });
      }, timeout);
    });
  }

  private clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  private getTimeout(options?: CompileOptions): number {
    const requestedTimeout = options?.timeout;

    if (typeof requestedTimeout === 'number' && requestedTimeout > 0) {
      return Math.min(Math.max(requestedTimeout, 1000), MAX_COMPILE_TIMEOUT);
    }

    return DEFAULT_COMPILE_TIMEOUT;
  }

  cancel(): boolean {
    if (!this._isCompiling) {
      return false;
    }

    this.clearTimeout();

    if (this._currentProcess) {
      try {
        this._currentProcess.kill('SIGTERM');
      } catch {
        // Ignore kill error
      }
    }
    this.emit('cancel');
    this._isCompiling = false;
    this._currentProcess = null;
    return true;
  }

  isCompiling(): boolean {
    return this._isCompiling;
  }

  async clean(options?: Pick<CompileOptions, 'projectPath' | 'mainFile'>): Promise<void> {
    logger.info('[TypstCompiler] Clean called', options);
    // Typst doesn't create many auxiliary files, but we can clean the temp directory
    try {
      await fs.remove(this.tempDir);
      await fs.ensureDir(this.tempDir);
    } catch (error) {
      console.warn('[TypstCompiler] Failed to clean temp directory:', error);
    }
  }

  // ================= Internal Methods =================

  private async compileProjectFile(
    content: string,
    mainFile: string,
    engine: 'typst' | 'tinymist',
    startTime: number
  ): Promise<TypstCompilationResult> {
    const workDir = path.dirname(mainFile);
    const baseName = path.basename(mainFile, '.typ');
    const pdfFile = path.join(workDir, `${baseName}.pdf`);
    let originalContent: string | null = null;
    try {
      originalContent = await fs.readFile(mainFile, 'utf-8');
    } catch {
      originalContent = null;
    }

    try {
      // Save content to file first
      await fs.writeFile(mainFile, content, 'utf-8');

      // Compile
      const result = await this.runCompiler(mainFile, pdfFile, workDir, engine);
      const time = Date.now() - startTime;

      if (!result.success && originalContent !== null) {
        try {
          const currentContent = await fs.readFile(mainFile, 'utf-8');
          if (currentContent === content) {
            await fs.writeFile(mainFile, originalContent, 'utf-8');
            logger.info('[TypstCompiler] Compilation failed, rolled back file content');
          } else {
            logger.warn(
              '[TypstCompiler] Compilation failed, but file content changed, skipping rollback'
            );
          }
        } catch (restoreError) {
          logger.warn('[TypstCompiler] Failed to rollback file content', restoreError);
        }
      }

      if (result.success && (await fs.pathExists(pdfFile))) {
        // Read PDF file to buffer (zero-copy optimization)
        let pdfBuffer: Uint8Array | undefined;
        try {
          const buffer = await fs.readFile(pdfFile);
          pdfBuffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } catch {
          // If read fails, still return the path
        }

        return {
          ...result,
          pdfPath: pdfFile,
          pdfBuffer,
          time,
        };
      }

      return {
        ...result,
        time,
      };
    } catch (error) {
      if (originalContent !== null) {
        try {
          const currentContent = await fs.readFile(mainFile, 'utf-8');
          if (currentContent === content) {
            await fs.writeFile(mainFile, originalContent, 'utf-8');
            logger.info('[TypstCompiler] Compilation failed, rolled back file content');
          } else {
            logger.warn(
              '[TypstCompiler] Compilation failed, but file content changed, skipping rollback'
            );
          }
        } catch (restoreError) {
          logger.warn('[TypstCompiler] Failed to rollback file content', restoreError);
        }
      }
      console.error('[TypstCompiler] Compilation error:', error);
      return {
        success: false,
        errors: [error instanceof Error ? error.message : String(error)],
        time: Date.now() - startTime,
      };
    }
  }

  private async compileTempFile(
    content: string,
    engine: 'typst' | 'tinymist',
    startTime: number
  ): Promise<TypstCompilationResult> {
    const tempFile = path.join(this.tempDir, `document_${Date.now()}.typ`);
    const pdfFile = path.join(this.tempDir, `document_${Date.now()}.pdf`);

    try {
      // Write temp file
      await fs.writeFile(tempFile, content, 'utf-8');

      // Compile
      const result = await this.runCompiler(tempFile, pdfFile, this.tempDir, engine);
      const time = Date.now() - startTime;

      if (result.success && (await fs.pathExists(pdfFile))) {
        // Read PDF as Uint8Array
        const pdfBuffer = await fs.readFile(pdfFile);
        const pdfUint8Array = new Uint8Array(
          pdfBuffer.buffer,
          pdfBuffer.byteOffset,
          pdfBuffer.byteLength
        );

        // Cleanup temp files
        try {
          await fs.remove(tempFile);
          await fs.remove(pdfFile);
        } catch (e) {
          console.warn('[TypstCompiler] Failed to clean temp files:', e);
        }

        return {
          ...result,
          pdfBuffer: pdfUint8Array,
          time,
        };
      }

      return {
        ...result,
        time,
      };
    } catch (error) {
      console.error('[TypstCompiler] Compilation error:', error);
      return {
        success: false,
        errors: [error instanceof Error ? error.message : String(error)],
        time: Date.now() - startTime,
      };
    }
  }

  /** Buffer size limit prevents memory overflow from large output */
  private async runCompiler(
    inputFile: string,
    outputFile: string,
    workDir: string,
    engine: 'typst' | 'tinymist'
  ): Promise<TypstCompilationResult> {
    const executable = await this.findExecutable(engine);

    if (!executable) {
      return {
        success: false,
        errors: [`${engine} executable not found. Please ensure it is properly installed.`],
      };
    }

    let outputPath = outputFile;
    try {
      const stat = await fs.stat(outputPath);
      if (stat.isDirectory()) {
        outputPath = path.join(outputPath, `${path.basename(inputFile, '.typ')}.pdf`);
      }
    } catch {
      // Don't handle when output path doesn't exist
    }
    if (path.extname(outputPath).toLowerCase() !== '.pdf') {
      outputPath = `${outputPath}.pdf`;
    }

    return new Promise((resolve) => {
      const args = ['compile', inputFile, outputPath];

      logger.info(`[TypstCompiler] Running: ${executable} ${args.join(' ')}`);

      const proc = spawn(executable, args, {
        cwd: workDir,
        env: augmentedEnv,
      });

      this._currentProcess = proc;

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();

        // Check buffer size to prevent memory overflow
        if (stdout.length < MAX_OUTPUT_BUFFER_SIZE) {
          const remaining = MAX_OUTPUT_BUFFER_SIZE - stdout.length;
          stdout += chunk.slice(0, remaining);

          if (chunk.length > remaining && !stdoutTruncated) {
            stdoutTruncated = true;
            console.warn(`[TypstCompiler] stdout truncated at ${MAX_OUTPUT_BUFFER_SIZE} bytes`);
          }
        }

        this.emit('log', {
          timestamp: Date.now(),
          level: 'info',
          message: chunk,
        } as CompileLogEntry);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();

        // Check buffer size to prevent memory overflow
        if (stderr.length < MAX_OUTPUT_BUFFER_SIZE) {
          const remaining = MAX_OUTPUT_BUFFER_SIZE - stderr.length;
          stderr += chunk.slice(0, remaining);

          if (chunk.length > remaining && !stderrTruncated) {
            stderrTruncated = true;
            console.warn(`[TypstCompiler] stderr truncated at ${MAX_OUTPUT_BUFFER_SIZE} bytes`);
          }
        }

        this.emit('log', {
          timestamp: Date.now(),
          level: 'warning',
          message: chunk,
        } as CompileLogEntry);
      });

      proc.on('close', (code) => {
        const log = stdout + stderr;
        const errors: string[] = [];
        const warnings: string[] = [];

        // Add truncation warning
        if (stdoutTruncated || stderrTruncated) {
          warnings.push(
            `[Warning] Compiler output was truncated due to size limit (${MAX_OUTPUT_BUFFER_SIZE / 1024 / 1024}MB)`
          );
        }

        // Parse errors and warnings
        const lines = log.split('\n');
        for (const line of lines) {
          if (line.includes('error:') || line.includes('Error:')) {
            errors.push(line.trim());
          } else if (line.includes('warning:') || line.includes('Warning:')) {
            warnings.push(line.trim());
          }
        }

        if (code === 0) {
          resolve({
            success: true,
            log,
            warnings: warnings.length > 0 ? warnings : undefined,
          });
        } else {
          resolve({
            success: false,
            errors: errors.length > 0 ? errors : [`Compilation failed, exit code: ${code}`],
            log,
          });
        }
      });

      proc.on('error', (error) => {
        resolve({
          success: false,
          errors: [`Failed to start compiler: ${error.message}`],
        });
      });
    });
  }

  private async findExecutable(engine: 'typst' | 'tinymist'): Promise<string | null> {
    const binName = process.platform === 'win32' ? `${engine}.exe` : engine;
    const candidates: string[] = [];

    // 1. Check environment variable
    const envVar = engine === 'tinymist' ? 'TINYMIST_PATH' : 'TYPST_PATH';
    if (process.env[envVar]) {
      candidates.push(process.env[envVar]!);
    }

    // 2. Check app bin path
    const appBinPath = this.getAppBinPath();
    candidates.push(path.join(appBinPath, binName));

    // 3. Check common install paths
    if (process.platform === 'win32') {
      candidates.push(
        path.join(process.env.LOCALAPPDATA || '', 'Programs', engine, binName),
        path.join(process.env.PROGRAMFILES || '', engine, binName),
        path.join(process.env.USERPROFILE || '', '.cargo', 'bin', binName)
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        `/usr/local/bin/${engine}`,
        `/opt/homebrew/bin/${engine}`,
        path.join(process.env.HOME || '', '.cargo', 'bin', engine)
      );
    } else {
      candidates.push(
        `/usr/bin/${engine}`,
        `/usr/local/bin/${engine}`,
        path.join(process.env.HOME || '', '.cargo', 'bin', engine)
      );
    }

    // 4. Check PATH
    candidates.push(binName);

    // Try each candidate
    for (const candidate of candidates) {
      try {
        if (candidate === binName) {
          const result = await this.checkExecutable(candidate);
          if (result) {
            logger.info(`[TypstCompiler] Found ${engine} in PATH`);
            return candidate;
          }
        } else if (await fs.pathExists(candidate)) {
          logger.info(`[TypstCompiler] Found ${engine} at:`, candidate);
          return candidate;
        }
      } catch {
        // Continue to next candidate
      }
    }

    console.warn(`[TypstCompiler] ${engine} executable not found`);
    return null;
  }

  private checkExecutable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(command, ['--version'], { env: augmentedEnv }, (error) => {
        resolve(!error);
      });
    });
  }

  private getAppBinPath(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return isPackaged() && resourcesPath
      ? path.join(resourcesPath, 'bin')
      : path.join(getAppPath(), 'resources', 'bin');
  }
}
