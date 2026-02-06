/**
 * @file Agent IPC Handlers (Type-Safe)
 * @description Handles CLI agent tasks: PDF-to-LaTeX conversion, paper review, and Beamer generation.
 * @depends IAgentService, PathSecurityService, fsCompat
 * @security All file paths validated via assertPathSecurity before operations
 */

import * as os from 'os';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { type PathAccessMode, checkPathSecurity } from '../services/PathSecurityService';
import type { IAgentService } from '../services/interfaces';
import fs from '../services/knowledge/utils/fsCompat';
import { createTypedHandlers } from './typedIpc';

/**
 * Validates path security and throws if access is denied.
 * @security Agent allows user-selected file paths (outside project scope)
 * @throws {Error} When path access is denied
 */
function assertPathSecurity(filePath: string, mode: PathAccessMode = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'user-selected');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(`Path access denied: ${result.reason}`);
  }
  return result.sanitizedPath || filePath;
}

const logger = createLogger('AgentHandlers');

/**
 * VLM configuration interface (matches CLI tool config format).
 */
interface VLMConfigForCLI {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Gets the SciPen global configuration directory.
 */
function getScipenHomeDir(): string {
  return path.join(os.homedir(), '.scipen');
}

/**
 * Syncs VLM configuration to ~/.scipen/config.json for CLI tools.
 * @sideeffect Writes configuration file to disk
 */
async function syncVLMConfigToFile(
  vlmConfig: VLMConfigForCLI
): Promise<{ success: boolean; message: string; path?: string }> {
  const scipenHome = getScipenHomeDir();
  const configPath = path.join(scipenHome, 'config.json');

  try {
    await fs.ensureDir(scipenHome);

    let existingConfig: Record<string, unknown> = {};
    if (await fs.pathExists(configPath)) {
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        existingConfig = JSON.parse(content);
      } catch {
        console.warn('[AgentHandlers] Existing config file corrupted, will overwrite');
      }
    }

    const newConfig = {
      ...existingConfig,
      version: existingConfig.version || '1.0.0',
      vlm: vlmConfig,
      metadata: {
        ...((existingConfig.metadata as Record<string, unknown>) || {}),
        updatedAt: new Date().toISOString(),
        source: 'scipen-studio',
      },
    };

    await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
    logger.info(`[AgentHandlers] VLM config synced to: ${configPath}`);

    return {
      success: true,
      message: 'VLM config synced successfully',
      path: configPath,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[AgentHandlers] VLM config sync failed:', errorMessage);
    return {
      success: false,
      message: `VLM config sync failed: ${errorMessage}`,
    };
  }
}

export interface AgentHandlersDeps {
  agentService: IAgentService;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Registers all agent-related IPC handlers.
 * @sideeffect Registers ipcMain handlers for CLI agent operations
 */
export function registerAgentHandlers(deps: AgentHandlersDeps): void {
  const { agentService, getMainWindow } = deps;

  const handlers = createTypedHandlers(
    {
      // ====== Agent Availability ======

      /** Checks which CLI agents are available */
      [IpcChannel.Agent_GetAvailable]: async () => {
        return agentService.checkAvailability();
      },

      // ====== Conversion Tasks ======

      /** Converts PDF to LaTeX using scipen-pdf2tex CLI */
      [IpcChannel.Agent_PDF2LaTeX]: async (inputFile, config) => {
        const safeInputFile = assertPathSecurity(inputFile, 'read');
        const safeOutputFile = config?.outputFile
          ? assertPathSecurity(config.outputFile, 'write')
          : undefined;

        return agentService.pdf2latex(
          safeInputFile,
          { outputFile: safeOutputFile, concurrent: config?.concurrent },
          {
            timeout: config?.timeout,
            onProgress: (message, progress) => {
              const mainWindow = getMainWindow();
              mainWindow?.webContents.send(IpcChannel.Agent_Progress, {
                type: 'pdf2latex',
                message,
                progress,
              });
            },
          }
        );
      },

      /** Reviews a paper using scipen-reviewer CLI */
      [IpcChannel.Agent_Review]: async (inputFile, timeout) => {
        const safeInputFile = assertPathSecurity(inputFile, 'read');

        return agentService.reviewPaper(safeInputFile, {
          timeout,
          onProgress: (message, progress) => {
            const mainWindow = getMainWindow();
            mainWindow?.webContents.send(IpcChannel.Agent_Progress, {
              type: 'review',
              message,
              progress,
            });
          },
        });
      },

      /** Converts paper to Beamer slides using scipen-beamer CLI */
      [IpcChannel.Agent_Paper2Beamer]: async (inputFile, config) => {
        const safeInputFile = assertPathSecurity(inputFile, 'read');
        const safeOutputFile = config?.output
          ? assertPathSecurity(config.output, 'write')
          : undefined;

        return agentService.paper2beamer(
          safeInputFile,
          { ...config, output: safeOutputFile },
          {
            timeout: config?.timeout,
            onProgress: (message, progress) => {
              const mainWindow = getMainWindow();
              mainWindow?.webContents.send(IpcChannel.Agent_Progress, {
                type: 'paper2beamer',
                message,
                progress,
              });
            },
          }
        );
      },

      /** Lists available Beamer templates */
      [IpcChannel.Agent_ListTemplates]: async () => {
        return agentService.listBeamerTemplates();
      },

      /** Kills the currently running agent process */
      [IpcChannel.Agent_Kill]: () => {
        return agentService.killCurrentProcess();
      },

      // ====== Configuration ======

      /** Syncs VLM config to ~/.scipen/config.json for CLI tools */
      [IpcChannel.Agent_SyncVLMConfig]: async (vlmConfig) => {
        return syncVLMConfigToFile(vlmConfig as VLMConfigForCLI);
      },

      // ====== Temporary Files ======

      /**
       * Creates a temporary file with security hardening.
       * @security Prevents path traversal attacks via filename sanitization
       */
      [IpcChannel.Agent_CreateTempFile]: async (fileName, content) => {
        try {
          if (!fileName || typeof fileName !== 'string') {
            console.error('[AgentHandlers] Invalid filename');
            return null;
          }

          if (!content || typeof content !== 'string') {
            console.error('[AgentHandlers] Invalid file content');
            return null;
          }

          // Content size limit (10MB)
          const MAX_CONTENT_SIZE = 10 * 1024 * 1024;
          if (content.length > MAX_CONTENT_SIZE) {
            console.error('[AgentHandlers] File content exceeds size limit');
            return null;
          }

          const scipenHome = getScipenHomeDir();
          const tempDir = path.join(scipenHome, 'temp');

          await fs.ensureDir(tempDir);

          // Sanitize filename to prevent path traversal
          const baseName = path.basename(fileName);
          const safeName = baseName
            .replace(/\.\./g, '')
            .replace(/[<>:"|?*\\/]/g, '-')
            .replace(/\x00/g, '')
            .slice(0, 200);

          if (!safeName || safeName.trim() === '') {
            console.error('[AgentHandlers] Filename empty after sanitization');
            return null;
          }

          const timestamp = Date.now();
          const tempFileName = `${timestamp}_${safeName}`;
          const tempFilePath = path.join(tempDir, tempFileName);

          // Final validation: ensure path is within temp directory
          const resolvedPath = path.resolve(tempFilePath);
          const resolvedTempDir = path.resolve(tempDir);
          if (!resolvedPath.startsWith(resolvedTempDir + path.sep)) {
            console.error('[AgentHandlers] Path traversal detected: target outside temp dir');
            return null;
          }

          const safeTempFilePath = assertPathSecurity(tempFilePath, 'write');

          await fs.writeFile(safeTempFilePath, content, 'utf-8');

          logger.info(`[AgentHandlers] Temp file created: ${safeTempFilePath}`);
          return safeTempFilePath;
        } catch (error) {
          console.error('[AgentHandlers] Failed to create temp file:', error);
          return null;
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Agent handlers registered (type-safe)');
}
