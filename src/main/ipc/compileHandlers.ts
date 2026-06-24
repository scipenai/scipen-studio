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
import { resolveWasmRoot } from '../services/WasmAssetProtocol';
import { CompilerRegistry } from '../services/compiler/CompilerRegistry';
import type { CompileMessage } from '../services/compiler/interfaces/ICompiler';
import type { ISyncTeXService } from '../services/interfaces';
import { createTypedHandlers } from './typedIpc';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const logger = createLogger('CompileHandlers');

function unavailableLatexCapabilities() {
  const unavailable = { available: false, version: null as string | null };
  return {
    cli: {
      pdflatex: { ...unavailable },
      xelatex: { ...unavailable },
      lualatex: { ...unavailable },
      tectonic: { ...unavailable },
    },
    wasm: {
      pdftex: { ...unavailable },
      xetex: { ...unavailable },
      lualatex: { ...unavailable },
    },
  };
}

async function getBusyTexWasmCapability(): Promise<{
  available: boolean;
  version: string | null;
}> {
  try {
    const busytexRoot = path.join(resolveWasmRoot(), 'busytex');
    const manifestPath = path.join(busytexRoot, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      version?: string;
      preload?: unknown;
      catalog?: unknown;
    };

    if (!Array.isArray(parsed.preload) || !Array.isArray(parsed.catalog)) {
      return { available: false, version: null };
    }

    await Promise.all(
      ['busytex.js', 'busytex.wasm', 'busytex_worker.js', 'busytex_pipeline.js'].map((file) =>
        fs.access(path.join(busytexRoot, file))
      )
    );

    return { available: true, version: parsed.version ?? null };
  } catch {
    return { available: false, version: null };
  }
}

function toParsedLogEntries(
  messages: CompileMessage[] | undefined,
  level: 'error' | 'warning' | 'info'
): Array<{
  line: number | null;
  file?: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content?: string;
  raw?: string;
}> {
  return (messages ?? [])
    .filter((entry) => entry.level === level)
    .map((entry) => ({
      line: entry.line ?? null,
      file: entry.file,
      level,
      message: entry.message,
      content: entry.message,
      raw: entry.message,
    }));
}

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
          // The IPC contract still requires LaTeXError[] / LaTeXWarning[].
          // Renderer-side already normalizes defensively, so keep the protocol backward-compatible.
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
      [IpcChannel.SyncTeX_Forward]: async (texFile, line, column, pdfFile, projectRoot) => {
        try {
          const safeTexFile = assertPathSecurity(texFile, 'read');
          const safePdfFile = assertPathSecurity(pdfFile, 'read');
          const safeProjectRoot = projectRoot ? assertPathSecurity(projectRoot, 'read') : undefined;

          const result = await syncTeXService.forwardSync(
            safePdfFile,
            safeTexFile,
            line,
            column,
            safeProjectRoot
          );
          return result;
        } catch (error) {
          console.error('SyncTeX forward sync failed:', error);
          return null;
        }
      },

      // SyncTeX backward sync: PDF position -> source location
      [IpcChannel.SyncTeX_Backward]: async (pdfFile, page, x, y, projectRoot) => {
        try {
          const safePdfFile = assertPathSecurity(pdfFile, 'read');
          const safeProjectRoot = projectRoot ? assertPathSecurity(projectRoot, 'read') : undefined;

          const result = await syncTeXService.inverseSync(safePdfFile, page, x, y, safeProjectRoot);
          return result;
        } catch (error) {
          console.error('SyncTeX backward sync failed:', error);
          return null;
        }
      },

      // Persist BusyTeX WASM artifacts (pdf + .synctex.gz) to a fresh temp
      // directory so the main-process `synctex` CLI can read them via the
      // same code path as a CLI-compiled result. Buffer is the renderer's
      // Uint8Array — it crosses the IPC boundary as a Node Buffer.
      [IpcChannel.Compile_WriteWasmArtifacts]: async (pdfBuffer, synctexBuffer, baseName) => {
        const safeName = baseName && /^[A-Za-z0-9_.-]+$/.test(baseName) ? baseName : 'main';
        const tempDir = path.join(os.tmpdir(), `scipen-wasm-${randomBytes(8).toString('hex')}`);
        await fs.mkdir(tempDir, { recursive: true });
        const pdfPath = path.join(tempDir, `${safeName}.pdf`);
        const synctexPath = path.join(tempDir, `${safeName}.synctex.gz`);
        await fs.writeFile(pdfPath, Buffer.from(pdfBuffer));
        await fs.writeFile(synctexPath, Buffer.from(synctexBuffer));
        return { pdfPath, synctexPath };
      },

      [IpcChannel.LaTeX_GetCapabilities]: async () => {
        const caps = unavailableLatexCapabilities();

        try {
          const latexCompiler = CompilerRegistry.get('latex-local') as LaTeXCompiler | undefined;
          if (latexCompiler) {
            const engines = await latexCompiler.getAvailableEngines();
            const byName = new Map(engines.map((engine) => [engine.engine, engine]));
            for (const engine of ['pdflatex', 'xelatex', 'lualatex', 'tectonic'] as const) {
              const capability = byName.get(engine);
              caps.cli[engine] = {
                available: capability?.available ?? false,
                version: capability?.version ?? null,
              };
            }
          }
        } catch (error) {
          logger.warn(`[LaTeX_GetCapabilities] CLI probe failed: ${String(error)}`);
        }

        const busytex = await getBusyTexWasmCapability();
        caps.wasm = {
          pdftex: { ...busytex },
          xetex: { ...busytex },
          lualatex: { ...busytex },
        };

        return caps;
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
          const parsedErrors = toParsedLogEntries(result.messages, 'error');
          const parsedWarnings = toParsedLogEntries(result.messages, 'warning');
          return {
            success: result.success,
            pdfPath: result.outputPath,
            pdfData: result.outputData, // @deprecated - kept for backward compatibility
            pdfBuffer: result.outputBuffer, // High-perf: binary zero-copy transfer
            errors: result.errors || [],
            warnings: result.warnings || [],
            parsedErrors,
            parsedWarnings,
            parsedInfo: [],
            log: result.log,
            duration: result.duration,
          };
        } catch (error) {
          console.error('Failed to compile Typst:', error);
          return {
            success: false,
            errors: [error instanceof Error ? error.message : 'Unknown error'],
            warnings: [],
            parsedErrors: toParsedLogEntries(
              [
                {
                  level: 'error',
                  message: error instanceof Error ? error.message : 'Unknown error',
                },
              ],
              'error'
            ),
            parsedWarnings: [],
            parsedInfo: [],
          };
        }
      },

      // Combined CLI + WASM Typst capability probe. Powers the Settings UI's
      // dynamic engine dropdown — see CompilerTab.tsx.
      [IpcChannel.Typst_GetCapabilities]: async () => {
        let cli = {
          tinymist: { available: false, version: null as string | null },
          typst: { available: false, version: null as string | null },
        };
        try {
          const typstCompiler = CompilerRegistry.get('typst-local') as TypstCompiler | undefined;
          if (typstCompiler) {
            const engines = await typstCompiler.getAvailableEngines();
            const tinymist = engines.find((e) => e.engine === 'tinymist');
            const typst = engines.find((e) => e.engine === 'typst');
            cli = {
              tinymist: {
                available: tinymist?.available ?? false,
                version: tinymist?.version ?? null,
              },
              typst: {
                available: typst?.available ?? false,
                version: typst?.version ?? null,
              },
            };
          }
        } catch (error) {
          logger.warn(`[Typst_GetCapabilities] CLI probe failed: ${String(error)}`);
        }

        // WASM probe: ask the filesystem, not the renderer. Reading
        // manifest.json from main avoids spinning up the worker just to
        // answer a settings-panel question.
        let wasm: { available: boolean; version: string | null } = {
          available: false,
          version: null,
        };
        try {
          const manifestPath = path.join(resolveWasmRoot(), 'typst-ts', 'manifest.json');
          const raw = await fs.readFile(manifestPath, 'utf-8');
          const parsed = JSON.parse(raw) as {
            compilerVersion?: string;
            compiler?: { mjs?: string; wasm?: string };
          };
          if (parsed.compiler?.mjs && parsed.compiler?.wasm) {
            wasm = {
              available: true,
              version: parsed.compilerVersion ?? null,
            };
          }
        } catch {
          // ENOENT or invalid JSON ⇒ assets not bundled. Treat as unavailable.
        }

        return { cli, wasm };
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
