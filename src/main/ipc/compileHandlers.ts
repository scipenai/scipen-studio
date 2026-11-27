/**
 * @file Compilation IPC handlers (Type-Safe)
 * @description Handles LaTeX/Typst compilation via IPC. SyncTeX is resolved
 *   entirely in the renderer (see renderer SyncTeXService) — no main-process
 *   `synctex` CLI involvement.
 * @depends CompilerRegistry, PathSecurityService
 * @security All file paths are validated via PathSecurityService before compilation
 *
 * Architecture:
 * - Compilers are lazy-loaded via CompilerRegistry
 * - Dynamic compiler selection by file extension or engine name
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  BusyTeXCompileRequestDTO,
  CompileProgressPayload,
} from '../../../shared/ipc/compile-contract';
import type { LaTeXCompiler } from '../services/LaTeXCompiler';
import { createLogger } from '../services/LoggerService';
import {
  type PathAccessMode,
  PathSecurityService,
  checkPathSecurity,
  isWithinCurrentProject,
} from '../services/PathSecurityService';
import { resolveCanonicalPath } from '../services/canonicalPath';
import type { TypstCompiler } from '../services/TypstCompiler';
import {
  probeTexliveEndpoint,
  resolveTexliveCacheDir,
  resolveWasmRoot,
} from '../services/WasmAssetProtocol';
import { TexliveRemoteCache } from '../services/TexliveRemoteCache';
import { BUSYTEX_STOPPED_MESSAGE, getBusyTexProcessClient } from '../services/BusyTexProcessClient';
import { CompilerRegistry } from '../services/compiler/CompilerRegistry';
import type {
  CompileMessage,
  CompileProgress,
  ICompiler,
} from '../services/compiler/interfaces/ICompiler';
import { createTypedHandlers } from './typedIpc';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const logger = createLogger('CompileHandlers');

/**
 * Cache handle for the maintenance channels (usage / clear misses).
 *
 * Deliberately NOT `getTexliveRemoteCache()`: that returns null under
 * `SCIPEN_TEXLIVE_REMOTE_CACHE=0`, yet the engine process caches
 * unconditionally (it never reads that variable), so going through the
 * singleton would report "0 entries" while the directory is full and in
 * active use. Maintenance operates on the directory itself.
 */
function maintenanceCache(): TexliveRemoteCache {
  return new TexliveRemoteCache({ cacheDir: resolveTexliveCacheDir() });
}

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

function validateBusyTexPath(
  filePath: string,
  mode: PathAccessMode,
  fallbackReason: string
): { ok: true; path: string } | { ok: false; error: string } {
  const result = checkPathSecurity(filePath, mode, 'project');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    return { ok: false, error: result.reason || fallbackReason };
  }
  return { ok: true, path: result.sanitizedPath || filePath };
}

// ====== Types ======

export interface CompileTypstOptions {
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
}

// ====== Handler Registration ======

/**
 * Push a compile-progress payload to every renderer window over
 * `Compile_Progress`. Same broadcast pattern as MinerUParseService —
 * getAllWindows + isDestroyed guard. Payloads are Zod-validated on the
 * renderer side (`eventSchemas`).
 */
function broadcastCompileProgress(payload: CompileProgressPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.Compile_Progress, payload);
    }
  }
}

/**
 * Subscribe to a compiler's `progress` event for the duration of one compile
 * and re-broadcast it over IPC. Scoped attach/detach (instead of a global
 * subscription at registration time) keeps `CompilerRegistry` lazy — no
 * compiler is instantiated until a compile actually needs it, and two
 * compilers never leak listeners into each other (compiles are serialized
 * by the queue upstream).
 */
function forwardCompilerProgress(
  compiler: ICompiler,
  engine: CompileProgressPayload['engine']
): () => void {
  const listener = (progress: CompileProgress) => {
    broadcastCompileProgress({
      engine,
      stage: 'cli',
      message: progress.message || progress.stage || '',
      percent: typeof progress.percent === 'number' ? progress.percent : undefined,
    });
  };
  compiler.on('progress', listener);
  return () => compiler.off('progress', listener);
}

/**
 * Register compilation-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for compile operations
 */
export function registerCompileHandlers(): void {
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
          const detachProgress = forwardCompilerProgress(latexCompiler, 'latex');
          let result;
          try {
            result = await latexCompiler.compile(content, compilationOptions);
          } finally {
            detachProgress();
          }
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
            pdfPath: result.outputPath,
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

      [IpcChannel.Compile_TestTexliveEndpoint]: async (endpoint) => {
        // Probe runs in main so it exercises the same `net.fetch` route the
        // BusyTeX worker's package fetches take (see WasmAssetProtocol).
        return probeTexliveEndpoint(endpoint);
      },

      [IpcChannel.Compile_GetTexliveCacheUsage]: async () => {
        try {
          const usage = maintenanceCache().usage();
          return { ok: true, ...usage };
        } catch (error) {
          // Total result: the settings pane renders whatever comes back.
          return {
            ok: false,
            binCount: 0,
            binBytes: 0,
            missCount: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      [IpcChannel.Compile_ClearTexliveMisses]: async () => {
        // Refuse while a compile is in flight. Pulling the probe results out
        // from under a running compile makes it re-fetch hundreds of URLs
        // serially and blow the 600 s cap — the user would see an
        // inexplicable timeout. Declining is also less surprising than
        // killing the engine: this action is about cache hygiene, not about
        // cancelling work.
        const client = getBusyTexProcessClient();
        if (client.isBusy) {
          return { ok: false, removed: 0, busy: true };
        }
        try {
          return { ok: true, ...maintenanceCache().clearMisses() };
        } catch (error) {
          return {
            ok: false,
            removed: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      [IpcChannel.Compile_ClearBuildCache]: async () => {
        // The client routes to the engine when it is running (so its
        // in-memory copy goes too) and refuses while a compile is in flight.
        try {
          return await getBusyTexProcessClient().clearBuildCache();
        } catch (error) {
          return {
            ok: false,
            removed: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      [IpcChannel.Compile_BusyTeX_Prepare]: async (projectRoot) => {
        // Only the active project may steer what the engine preloads; any
        // other root falls back to the basic packages.
        const root = projectRoot && isWithinCurrentProject(projectRoot) ? projectRoot : undefined;
        await getBusyTexProcessClient().ensureLoaded(root);
        return { ok: true };
      },

      [IpcChannel.Compile_BusyTeX_Compile]: async (request: BusyTeXCompileRequestDTO) => {
        // The engine process walks projectRoot itself, so it must be the
        // active project (or inside it). Validate every compile path
        // unconditionally before forwarding to the utility process.
        const projectRootCheck = request.projectRoot
          ? checkPathSecurity(request.projectRoot, 'read', 'project')
          : null;
        const sanitizedProjectRoot = projectRootCheck?.allowed
          ? projectRootCheck.sanitizedPath || request.projectRoot
          : undefined;
        const projectRoot =
          sanitizedProjectRoot && isWithinCurrentProject(sanitizedProjectRoot)
            ? sanitizedProjectRoot
            : undefined;
        if (request.projectRoot && !projectRoot) {
          logger.warn(
            'BusyTeX compile: projectRoot outside the active project, staging buffer only'
          );
        }

        const outputCheck = validateBusyTexPath(
          request.outputDir,
          'write',
          'Output directory access denied'
        );
        if (!outputCheck.ok) {
          return { success: false, log: '', errors: [outputCheck.error] };
        }
        const mainFileCheck = validateBusyTexPath(
          request.mainFileAbs,
          'read',
          'Main file access denied'
        );
        if (!mainFileCheck.ok) {
          return { success: false, log: '', errors: [mainFileCheck.error] };
        }
        const overlayCheck = validateBusyTexPath(
          request.overlay.absPath,
          'read',
          'Overlay file access denied'
        );
        if (!overlayCheck.ok) {
          return { success: false, log: '', errors: [overlayCheck.error] };
        }

        if (projectRoot && !isWithinCurrentProject(outputCheck.path)) {
          return { success: false, log: '', errors: ['Output directory is outside the project'] };
        }

        // Validate every file this compile will write so pre-planted file
        // symlinks inside outputDir cannot redirect PDF, SyncTeX, or log writes.
        for (const ext of ['.pdf', '.synctex.gz', '.log']) {
          const artifactPath = path.join(outputCheck.path, `${request.baseName}${ext}`);
          const artifactCheck = validateBusyTexPath(
            artifactPath,
            'write',
            'Output file access denied'
          );
          if (!artifactCheck.ok) {
            return { success: false, log: '', errors: [artifactCheck.error] };
          }
          if (projectRoot && !isWithinCurrentProject(artifactCheck.path)) {
            return { success: false, log: '', errors: ['Output file is outside the project'] };
          }
        }

        const outputSandboxRoot = isWithinCurrentProject(outputCheck.path)
          ? (PathSecurityService.getProjectPath() ?? undefined)
          : (resolveCanonicalPath(outputCheck.path) ?? undefined);

        const client = getBusyTexProcessClient();
        // Phases parsed from engine prints flow to the renderer over the
        // existing Compile_Progress channel; scoped so a compile that starts
        // mid-flight cannot leak another compile's prints into it.
        const disposePhase = client.onPhase((phase) => broadcastCompileProgress(phase));
        try {
          const result = await client.compile({
            ...request,
            projectRoot,
            mainFileAbs: mainFileCheck.path,
            overlay: { ...request.overlay, absPath: overlayCheck.path },
            outputDir: outputCheck.path,
            outputSandboxRoot,
          });
          return {
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            pdfPath: result.pdfPath,
            synctexPath: result.synctexPath,
            log: result.log,
            errors: result.exitCode === 0 ? [] : ['Compilation failed'],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Stop button / idle release — neutral outcome, not a failure.
          if (message === BUSYTEX_STOPPED_MESSAGE) {
            return { success: false, cancelled: true, log: '', errors: [] };
          }
          logger.error('BusyTeX engine compile failed', { error: message });
          return { success: false, log: '', errors: [message] };
        } finally {
          disposePhase.dispose();
        }
      },

      [IpcChannel.Compile_BusyTeX_Cancel]: async () => {
        getBusyTexProcessClient().kill();
        return { ok: true };
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
