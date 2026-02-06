/**
 * @file Compilation IPC handlers (Type-Safe)
 * @description Handles LaTeX/Typst compilation and SyncTeX sync via IPC.
 * @depends CompilerRegistry, ISyncTeXService, PathSecurityService
 * @security All file paths are validated via PathSecurityService before compilation
 *
 * Architecture:
 * - Compilers are lazy-loaded via CompilerRegistry
 * - Dynamic compiler selection by file extension or engine name
 * - SyncTeX service injected for bidirectional sync
 */

import { IpcChannel } from '../../../shared/ipc/channels';
import type { LaTeXCompiler } from '../services/LaTeXCompiler';
import { createLogger } from '../services/LoggerService';
import { type PathAccessMode, checkPathSecurity } from '../services/PathSecurityService';
import type { TypstCompiler } from '../services/TypstCompiler';
import { CompilerRegistry } from '../services/compiler/CompilerRegistry';
import type { ISyncTeXService } from '../services/interfaces';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('CompileHandlers');

// ====== Security Helpers ======

/**
 * Validate path security and throw if unsafe.
 * @throws {Error} If path is outside project sandbox
 */
function assertPathSecurity(filePath: string, mode: PathAccessMode = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'project');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(`Path access denied: ${result.reason}`);
  }
  return result.sanitizedPath || filePath;
}

// ====== Types ======

export interface CompileTypstOptions {
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
}

/** Compile handler dependencies (injected at registration) */
export interface CompileHandlersDeps {
  /** SyncTeX service for bidirectional source-PDF sync */
  syncTeXService: ISyncTeXService;
}

// ====== Handler Registration ======

/**
 * Register compilation-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for compile operations
 */
export function registerCompileHandlers(deps: CompileHandlersDeps): void {
  const { syncTeXService } = deps;

  const handlers = createTypedHandlers(
    {
      // LaTeX compilation via CompilerRegistry (lazy instantiation)
      [IpcChannel.Compile_LaTeX]: async (content, options) => {
        try {
          const latexCompiler = CompilerRegistry.get('latex-local');
          if (!latexCompiler) {
            throw new Error('LaTeX compiler not registered or unavailable');
          }

          // Path security validation
          const safeMainFile = options?.mainFile
            ? assertPathSecurity(options.mainFile, 'read')
            : undefined;
          const safeOutputDir = options?.outputDir
            ? assertPathSecurity(options.outputDir, 'write')
            : undefined;

          const compilationOptions = options
            ? {
                engine: options.engine,
                outputDir: safeOutputDir,
                mainFile: safeMainFile,
              }
            : undefined;
          const result = await latexCompiler.compile(content, compilationOptions);
          // Convert errors format: string[] -> LaTeXError[]
          const errors = result.errors?.map((msg) => ({
            message: msg,
            line: 0,
            file: '',
            severity: 'error' as const,
          }));
          return {
            success: result.success,
            pdfPath: result.outputPath, // ICompiler uses outputPath
            pdfData: result.outputData, // @deprecated - ICompiler uses outputData (Base64)
            pdfBuffer: result.outputBuffer, // High-perf: binary zero-copy transfer
            synctexPath: result.synctexPath,
            errors,
            warnings: result.warnings?.map((msg) => ({
              message: msg,
              line: 0,
              file: '',
              type: 'other' as const,
            })),
            log: result.log,
          };
        } catch (error) {
          console.error('Failed to compile LaTeX:', error);
          return {
            success: false,
            errors: [
              {
                message: error instanceof Error ? error.message : 'Unknown error',
                line: 0,
                file: '',
                severity: 'error' as const,
              },
            ],
          };
        }
      },

      // SyncTeX forward sync: source location -> PDF position
      [IpcChannel.SyncTeX_Forward]: async (texFile, line, column, pdfFile) => {
        try {
          const safeTexFile = assertPathSecurity(texFile, 'read');
          const safePdfFile = assertPathSecurity(pdfFile, 'read');

          const result = await syncTeXService.forwardSync(safePdfFile, safeTexFile, line, column);
          return result;
        } catch (error) {
          console.error('SyncTeX forward sync failed:', error);
          return null;
        }
      },

      // SyncTeX backward sync: PDF position -> source location
      [IpcChannel.SyncTeX_Backward]: async (pdfFile, page, x, y) => {
        try {
          const safePdfFile = assertPathSecurity(pdfFile, 'read');

          const result = await syncTeXService.inverseSync(safePdfFile, page, x, y);
          return result;
        } catch (error) {
          console.error('SyncTeX backward sync failed:', error);
          return null;
        }
      },

      // Typst compilation via CompilerRegistry (lazy instantiation)
      [IpcChannel.Compile_Typst]: async (content, options) => {
        try {
          const typstCompiler = CompilerRegistry.get('typst-local');
          if (!typstCompiler) {
            throw new Error('Typst compiler not registered or unavailable');
          }

          // Path security validation
          const safeMainFile = options?.mainFile
            ? assertPathSecurity(options.mainFile, 'read')
            : undefined;
          const safeProjectPath = options?.projectPath
            ? assertPathSecurity(options.projectPath, 'read')
            : undefined;

          const compilationOptions = options
            ? {
                engine: options.engine as 'typst' | 'tinymist' | undefined,
                mainFile: safeMainFile,
                projectPath: safeProjectPath,
              }
            : undefined;
          const result = await typstCompiler.compile(content, compilationOptions);
          return {
            success: result.success,
            pdfPath: result.outputPath,
            pdfData: result.outputData, // @deprecated - kept for backward compatibility
            pdfBuffer: result.outputBuffer, // High-perf: binary zero-copy transfer
            errors: result.errors || [],
            warnings: result.warnings,
            log: result.log,
            duration: result.duration,
          };
        } catch (error) {
          console.error('Failed to compile Typst:', error);
          return {
            success: false,
            errors: [error instanceof Error ? error.message : 'Unknown error'],
          };
        }
      },

      // Check Typst compiler availability via Registry
      [IpcChannel.Typst_Available]: async () => {
        try {
          const typstCompiler = CompilerRegistry.get('typst-local');
          if (!typstCompiler) {
            return {
              tinymist: { available: false, version: null },
              typst: { available: false, version: null },
            };
          }

          // Get available engines from ICompiler interface
          const engines = await typstCompiler.getAvailableEngines();
          const tinymistEngine = engines.find((e) => e.engine === 'tinymist');
          const typstEngine = engines.find((e) => e.engine === 'typst');

          return {
            tinymist: {
              available: tinymistEngine?.available ?? false,
              version: tinymistEngine?.version ?? null,
            },
            typst: {
              available: typstEngine?.available ?? false,
              version: typstEngine?.version ?? null,
            },
          };
        } catch (error) {
          console.error('Failed to check Typst availability:', error);
          return {
            tinymist: { available: false, version: null },
            typst: { available: false, version: null },
          };
        }
      },

      [IpcChannel.Compile_Cancel]: async (type) => {
        let cancelled = 0;

        if (!type || type === 'latex') {
          const latexCompiler = CompilerRegistry.get('latex-local') as LaTeXCompiler | undefined;
          if (latexCompiler && typeof latexCompiler.cancelAll === 'function') {
            cancelled += latexCompiler.cancelAll();
          }
        }

        if (!type || type === 'typst') {
          const typstCompiler = CompilerRegistry.get('typst-local') as TypstCompiler | undefined;
          if (typstCompiler && typeof typstCompiler.cancel === 'function') {
            if (typstCompiler.cancel()) {
              cancelled += 1;
            }
          }
        }

        logger.info(`[Compile_Cancel] Cancelled ${cancelled} compilation tasks`);
        return { success: true, cancelled };
      },

      [IpcChannel.Compile_GetStatus]: async () => {
        const latexCompiler = CompilerRegistry.get('latex-local') as LaTeXCompiler | undefined;
        const typstCompiler = CompilerRegistry.get('typst-local') as TypstCompiler | undefined;

        const latexStatus = latexCompiler?.getQueueStatus?.() ?? {
          isCompiling: false,
          queueLength: 0,
          currentTaskId: null,
        };

        return {
          latex: latexStatus,
          typst: {
            isCompiling: typstCompiler?.isCompiling?.() ?? false,
          },
        };
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Compile handlers registered');
}
