/**
 * @file LSP IPC handlers (Type-Safe)
 * @description Handles Language Server Protocol operations for TexLab (LaTeX) and Tinymist (Typst).
 * @depends LSPProcessClient (runs in UtilityProcess for zero main-thread blocking)
 * @security All document paths validated via PathSecurityService
 */

import type { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { LSPDocumentSymbol } from '../../../shared/api-types';
import { type LSPProcessClient, getLSPProcessClient } from '../services/LSPProcessClient';
import { createLogger } from '../services/LoggerService';
import { type PathAccessMode, checkPathSecurity } from '../services/PathSecurityService';
import { createTypedHandlers, registerTypedHandler } from './typedIpc';

const logger = createLogger('LSPHandlers');

// ====== Path Helpers ======

/**
 * Validate path security, throws if unsafe.
 */
function assertPathSecurity(filePath: string, mode: PathAccessMode = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'project');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(result.reason || 'Access denied');
  }
  return result.sanitizedPath || filePath;
}

export interface LSPHandlersDeps {
  getMainWindow: () => BrowserWindow | null;
}

export function registerLSPHandlers(deps: LSPHandlersDeps): void {
  const { getMainWindow } = deps;
  const lspClient = getLSPProcessClient();

  logger.info('[LSP Handlers] Using UtilityProcess mode');

  // Setup event forwarding
  setupEventForwarding(lspClient, getMainWindow);

  const handlers = createTypedHandlers(
    {
      // ====== Process Status Query ======

      // Get LSP process mode and status
      [IpcChannel.LSP_GetProcessInfo]: async () => {
        return {
          mode: 'utility-process',
          processAlive: lspClient.isProcessAlive(),
          initialized: lspClient.isInitialized(),
        };
      },

      // ====== Availability Check ======

      // Check if any LSP is available
      [IpcChannel.LSP_IsAvailable]: async () => {
        const availability = await lspClient.checkAvailability();
        return availability.texlab || availability.tinymist || availability.marksman;
      },

      // Get version (legacy API compat, returns TexLab version)
      [IpcChannel.LSP_GetVersion]: async () => {
        const availability = await lspClient.checkAvailability();
        return availability.texlabVersion;
      },

      // ====== Lifecycle Management ======

      // Start all LSP servers
      [IpcChannel.LSP_Start]: async (rootPath, options) => {
        // Path security check
        const safePath = assertPathSecurity(rootPath, 'read');
        const result = await lspClient.start(safePath, options);
        // Return true if any service started successfully (legacy API compat)
        return result.texlab || result.tinymist;
      },

      // Stop all LSP servers
      [IpcChannel.LSP_Stop]: async () => {
        await lspClient.stop();
      },

      // Check if running
      [IpcChannel.LSP_IsRunning]: async () => {
        return lspClient.isRunning();
      },

      // Check if virtual mode
      [IpcChannel.LSP_IsVirtualMode]: async () => {
        return lspClient.isVirtualMode();
      },

      // ====== Document Operations ======

      // Open document
      [IpcChannel.LSP_OpenDocument]: async (filePath, content, languageId) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        await lspClient.openDocument(safePath, content, languageId);
      },

      // Update document (full)
      [IpcChannel.LSP_UpdateDocument]: async (filePath, content) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'write');
        await lspClient.updateDocument(safePath, content);
      },

      // Incremental document update
      [IpcChannel.LSP_UpdateDocumentIncremental]: async (filePath, changes) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'write');
        await lspClient.updateDocumentIncremental(safePath, changes);
      },

      // Close document
      [IpcChannel.LSP_CloseDocument]: async (filePath) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        await lspClient.closeDocument(safePath);
      },

      // Save document
      [IpcChannel.LSP_SaveDocument]: async (filePath) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'write');
        await lspClient.saveDocument(safePath);
      },

      // ====== Language Features ======

      // Get completions
      [IpcChannel.LSP_GetCompletions]: async (filePath, line, character) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.getCompletions(safePath, line, character);
        return result as {
          label: string;
          kind?: number;
          detail?: string;
          documentation?: string;
          insertText?: string;
          sortText?: string;
        }[];
      },

      // Get hover info
      [IpcChannel.LSP_GetHover]: async (filePath, line, character) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.getHover(safePath, line, character);
        return result as {
          contents:
            | string
            | { kind: string; value: string }
            | Array<string | { kind: string; value: string }>;
          range?: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        } | null;
      },

      // Go to definition
      [IpcChannel.LSP_GetDefinition]: async (filePath, line, character) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.getDefinition(safePath, line, character);
        return result as
          | {
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            }
          | {
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            }[]
          | null;
      },

      // Find references
      [IpcChannel.LSP_GetReferences]: async (filePath, line, character, includeDeclaration) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.getReferences(safePath, line, character, includeDeclaration);
        return result as {
          uri: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        }[];
      },

      // Get document symbols
      [IpcChannel.LSP_GetSymbols]: async (filePath) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.getDocumentSymbols(safePath);
        return result as LSPDocumentSymbol[];
      },

      // Get semantic tokens
      [IpcChannel.LSP_GetSemanticTokens]: async (filePath) => {
        const safePath = assertPathSecurity(filePath, 'read');
        return lspClient.getSemanticTokens(safePath);
      },

      // ====== TexLab Specific Features ======

      // Build (TexLab)
      [IpcChannel.LSP_Build]: async (filePath) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.build(safePath);
        return {
          success: result.status === 'success',
          error: result.status !== 'success' ? result.status : undefined,
        };
      },

      // Forward search (TexLab)
      [IpcChannel.LSP_ForwardSearch]: async (filePath, line) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await lspClient.forwardSearch(safePath, line);
        return {
          success: result.status === 'success',
          error: result.status !== 'success' ? result.status : undefined,
        };
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();

  // Request direct channel to LSP process - requires event.sender
  registerTypedHandler(
    IpcChannel.LSP_RequestDirectChannel,
    async (event) => {
      const channel = lspClient.createRendererChannel();

      if (!channel) {
        return { success: false, error: 'LSP process not started' };
      }

      // Send port1 to renderer process
      event.sender.postMessage(IpcChannel.LSP_DirectChannel, null, [channel.port1]);

      return { success: true };
    },
    { logErrors: true }
  );

  // Extra LSP handlers (extension APIs not defined in IPCApiContract)
  registerExtraLSPHandlers(lspClient);

  logger.info('[IPC] LSP handlers registered (type-safe)');
}

/** Register extra LSP handlers (extension APIs). */
function registerExtraLSPHandlers(lspClient: LSPProcessClient): void {
  createTypedHandlers({
    [IpcChannel.LSP_IsTexLabAvailable]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.texlab;
    },
    [IpcChannel.LSP_IsTinymistAvailable]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.tinymist;
    },
    [IpcChannel.LSP_IsMarksmanAvailable]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.marksman;
    },
    [IpcChannel.LSP_CheckAvailability]: async () => {
      const a = await lspClient.checkAvailability();
      return {
        texlab: a.texlab,
        tinymist: a.tinymist,
        marksman: a.marksman,
        texlabVersion: a.texlabVersion ?? undefined,
        tinymistVersion: a.tinymistVersion ?? undefined,
        marksmanVersion: a.marksmanVersion ?? undefined,
      };
    },
    [IpcChannel.LSP_GetTexLabVersion]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.texlabVersion ?? undefined;
    },
    [IpcChannel.LSP_GetTinymistVersion]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.tinymistVersion ?? undefined;
    },
    [IpcChannel.LSP_GetMarksmanVersion]: async () => {
      const availability = await lspClient.checkAvailability();
      return availability.marksmanVersion ?? undefined;
    },
  }).registerAll();

  // Start all services and return detailed results (has path param, needs type safety)
  registerTypedHandler(
    IpcChannel.LSP_StartAll,
    async (_event, rootPath: string, options?: { virtual?: boolean }) => {
      const safePath = assertPathSecurity(rootPath, 'read');
      return lspClient.start(safePath, options);
    }
  );

  // Start TexLab only
  registerTypedHandler(
    IpcChannel.LSP_StartTexLab,
    async (_event, rootPath: string, options?: { virtual?: boolean }) => {
      const safePath = assertPathSecurity(rootPath, 'read');
      const result = await lspClient.start(safePath, options);
      return result.texlab;
    }
  );

  // Start Tinymist only
  registerTypedHandler(
    IpcChannel.LSP_StartTinymist,
    async (_event, rootPath: string, options?: { virtual?: boolean }) => {
      const safePath = assertPathSecurity(rootPath, 'read');
      const result = await lspClient.start(safePath, options);
      return result.tinymist;
    }
  );

  // Start Marksman only
  registerTypedHandler(
    IpcChannel.LSP_StartMarksman,
    async (_event, rootPath: string, options?: { virtual?: boolean }) => {
      const safePath = assertPathSecurity(rootPath, 'read');
      const result = await lspClient.start(safePath, options);
      return result.marksman;
    }
  );

  // Export PDF (Tinymist)
  registerTypedHandler(IpcChannel.LSP_ExportTypstPdf, async (_event, filePath: string) => {
    const safePath = assertPathSecurity(filePath, 'read');
    return lspClient.exportTypstPdf(safePath);
  });

  // Format Typst document
  registerTypedHandler(IpcChannel.LSP_FormatTypst, async (_event, filePath: string) => {
    const safePath = assertPathSecurity(filePath, 'read');
    return lspClient.formatTypstDocument(safePath);
  });
}

// Setup LSP event forwarding
function setupEventForwarding(
  client: LSPProcessClient,
  getMainWindow: () => BrowserWindow | null
): void {
  // Diagnostics event
  client.on('diagnostics', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_Diagnostics, data);
  });

  // Initialized event
  client.on('initialized', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_Initialized, data);
  });

  // Exit event
  client.on('exit', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_Exit, data);
  });

  // Error event
  client.on('error', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_Error, data);
  });

  // Service started event
  client.on('serviceStarted', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_ServiceStarted, data);
  });

  // Service stopped event
  client.on('serviceStopped', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_ServiceStopped, data);
  });

  // Service restarted event (individual TexLab/Tinymist crash restart)
  client.on('serviceRestarted', (data) => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_ServiceRestarted, data);
    logger.info(`[LSP Handlers] LSP service restarted: ${(data as { service: string }).service}`);
  });

  // Process recovered event
  client.on('recovered', () => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_Recovered);
    logger.info('[LSP Handlers] LSP process auto-recovered');
  });

  // MessagePort direct channel closed event
  client.on('directChannelClosed', () => {
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IpcChannel.LSP_DirectChannelClosed);
    logger.info('[LSP Handlers] LSP direct channel closed, renderer can re-request connection');
  });
}
