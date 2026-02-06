/**
 * @file Overleaf IPC handlers (Type-Safe)
 * @description Handles Overleaf project import, sync, and remote compilation.
 * @depends IOverleafService (stateful - created on login, destroyed on logout)
 * @security Cookies encrypted via safeStorage; actual cookie values never exposed via IPC
 *
 * Note: Overleaf service is stateful (login state, cookies).
 * Uses getter/setter pattern instead of direct DI injection.
 */

import { IpcChannel } from '@shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { OverleafCompiler } from '../services/OverleafCompiler';
import type { IOverleafService, OverleafConfig } from '../services/interfaces';
import type {
  OverleafCompileOptions as OverleafCompileOpts,
  OverleafProjectSettings,
} from '../types/ipc';
import { createTypedHandlers } from './typedIpc';

import { toOverleafCompileResultDTO, toOverleafProjectDTOList } from '../utils/mappers';

const logger = createLogger('OverleafHandlers');

// ====== Types ======

export interface OverleafHandlersDeps {
  getOverleafCompiler: () => IOverleafService | null;
  setOverleafCompiler: (compiler: IOverleafService | null) => void;
}

// ====== Handler Registration ======

/**
 * Register Overleaf-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for Overleaf operations
 */
export function registerOverleafHandlers(deps: OverleafHandlersDeps): void {
  const { getOverleafCompiler, setOverleafCompiler } = deps;

  const handlers = createTypedHandlers(
    {
      [IpcChannel.Overleaf_Init]: async (config) => {
        setOverleafCompiler(
          new OverleafCompiler(config as OverleafConfig) as unknown as IOverleafService
        );
        return { success: true };
      },

      // Test Overleaf connection
      [IpcChannel.Overleaf_TestConnection]: async (serverUrl) => {
        const tempCompiler = new OverleafCompiler({ serverUrl });
        return tempCompiler.testConnection();
      },

      [IpcChannel.Overleaf_Login]: async (config) => {
        const compiler = new OverleafCompiler(config as OverleafConfig);
        setOverleafCompiler(compiler as unknown as IOverleafService);
        return compiler.login();
      },

      [IpcChannel.Overleaf_IsLoggedIn]: () => {
        const overleafCompiler = getOverleafCompiler();
        return overleafCompiler?.isLoggedIn() || false;
      },

      // Cookies stored encrypted via safeStorage; never expose actual values
      // Use Overleaf_IsLoggedIn to check login status instead
      [IpcChannel.Overleaf_GetCookies]: () => {
        const overleafCompiler = getOverleafCompiler();
        const hasCookies = overleafCompiler?.isLoggedIn() ?? false;
        return hasCookies ? '[encrypted]' : null;
      },

      [IpcChannel.Overleaf_GetProjects]: async () => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return [];
        }
        try {
          const projects = await overleafCompiler.getProjects();
          return toOverleafProjectDTOList(projects);
        } catch {
          return [];
        }
      },

      // Get project details
      [IpcChannel.Overleaf_GetProjectDetails]: async (projectId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false, error: 'Please login to Overleaf first' };
        }
        try {
          const details = await overleafCompiler.getProjectDetails(projectId);
          if (details) {
            return { success: true, details };
          }
          return { success: false, error: 'Failed to get project details' };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get project details',
          };
        }
      },

      // Update project settings
      [IpcChannel.Overleaf_UpdateSettings]: async (projectId, settings) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false };
        }
        try {
          const result = await overleafCompiler.updateProjectSettings(
            projectId,
            settings as OverleafProjectSettings
          );
          return { success: result };
        } catch {
          return { success: false };
        }
      },

      // Compile with Overleaf (uses Mapper)
      [IpcChannel.Overleaf_Compile]: async (projectId, options) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false, status: 'error', errors: ['Please login to Overleaf first'] };
        }

        try {
          const result = await overleafCompiler.compile(projectId, options as OverleafCompileOpts);
          const resultDTO = toOverleafCompileResultDTO(result);

          if (result.success && result.pdfUrl) {
            // Download PDF data
            const pdfArrayBuffer = await overleafCompiler.downloadPdf(result.pdfUrl);
            if (pdfArrayBuffer) {
              // Convert Node Buffer/ArrayBuffer to pure Uint8Array
              // Reason: Electron IPC serialization may be inconsistent for Node Buffer
              // Pure Uint8Array is a Web standard type, more reliable for IPC transfer
              const pdfBuffer = new Uint8Array(pdfArrayBuffer);
              logger.info(
                `[Overleaf_Compile] PDF downloaded, size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`
              );
              return {
                ...resultDTO,
                pdfBuffer, // Return pure Uint8Array, not Node Buffer
              };
            }
          }

          // Download and parse compile log
          if (result.logUrl && result.buildId) {
            const log = await overleafCompiler.downloadLog(result.logUrl);
            if (log) {
              resultDTO.errors = resultDTO.errors || [];
              const errorLines = log
                .split('\n')
                .filter(
                  (line) => line.includes('Error:') || line.includes('!') || line.includes('error:')
                );
              resultDTO.errors.push(...errorLines.slice(0, 10));
            }
          }

          return resultDTO;
        } catch (error) {
          return {
            success: false,
            status: 'error',
            errors: [error instanceof Error ? error.message : 'Compile failed'],
          };
        }
      },

      // Stop Overleaf compile
      [IpcChannel.Overleaf_StopCompile]: async (projectId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) return { success: false };
        const result = await overleafCompiler.stopCompile(projectId);
        return { success: result };
      },

      // Get last build ID
      [IpcChannel.Overleaf_GetBuildId]: () => {
        const overleafCompiler = getOverleafCompiler();
        return overleafCompiler?.getLastBuildId() || null;
      },

      // SyncTeX forward sync (code -> PDF)
      [IpcChannel.Overleaf_SyncCode]: async (projectId, file, line, column, buildId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) return null;
        try {
          const result = await overleafCompiler.syncCode(projectId, file, line, column, buildId);
          if (!result || result.length === 0) return null;
          return result.map((pos) => ({
            page: pos.page,
            h: pos.h,
            v: pos.v,
            width: pos.width || 50,
            height: pos.height || 20,
          }));
        } catch {
          return null;
        }
      },

      // SyncTeX backward sync (PDF -> code)
      [IpcChannel.Overleaf_SyncPdf]: async (projectId, page, h, v, buildId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) return null;
        try {
          const result = await overleafCompiler.syncPdf(projectId, page, h, v, buildId);
          if (!result) return null;
          return { file: result.file, line: result.line, column: result.column };
        } catch {
          return null;
        }
      },

      // Get document content
      [IpcChannel.Overleaf_GetDoc]: async (projectId, docIdOrPath, isPath) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false, error: 'Please login to Overleaf first' };
        }
        try {
          let content: string | null = null;
          let docId: string | undefined;

          if (isPath || !docIdOrPath || docIdOrPath.includes('/') || docIdOrPath.includes('.')) {
            const result = await overleafCompiler.getDocByPathWithId(projectId, docIdOrPath);
            if (result) {
              content = result.content;
              docId = result.docId;
            }
          } else {
            docId = docIdOrPath;
            content = await overleafCompiler.getDocViaSocket(projectId, docIdOrPath);
            if (content === null) {
              content = await overleafCompiler.getDocContent(projectId, docIdOrPath);
            }
          }

          if (content !== null) {
            return { success: true, content, docId };
          }
          return { success: false, error: 'Document content is empty' };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to read document',
          };
        }
      },

      // Update document content
      [IpcChannel.Overleaf_UpdateDoc]: async (projectId, docId, content) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false };
        }
        try {
          // updateDocContent returns { success: boolean } directly
          return await overleafCompiler.updateDocContent(projectId, docId, content);
        } catch {
          return { success: false };
        }
      },

      // Update document content with debounce
      [IpcChannel.Overleaf_UpdateDocDebounced]: async (projectId, docId, content) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false };
        }
        try {
          // updateDocDebounced returns { success: boolean }
          return await overleafCompiler.updateDocDebounced(projectId, docId, content);
        } catch {
          return { success: false };
        }
      },

      // Flush pending updates
      [IpcChannel.Overleaf_FlushUpdates]: async (projectId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return { success: false };
        }
        try {
          await overleafCompiler.flushUpdates(projectId);
          return { success: true };
        } catch {
          return { success: false };
        }
      },

      // Get document from cache
      [IpcChannel.Overleaf_GetDocCached]: async (projectId, docId) => {
        const overleafCompiler = getOverleafCompiler();
        if (!overleafCompiler) {
          return null;
        }
        return overleafCompiler.getDocCached(projectId, docId);
      },

      // Clear document cache
      [IpcChannel.Overleaf_ClearCache]: (projectId, docId) => {
        const overleafCompiler = getOverleafCompiler();
        if (overleafCompiler) {
          overleafCompiler.clearCache(projectId, docId);
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Overleaf handlers registered (type-safe with mappers)');
}
