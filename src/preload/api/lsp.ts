/**
 * @file LSP API - Language Server Protocol API Module
 * @description Provides IPC interfaces for TexLab/Tinymist LSP startup, document sync, completion, diagnostics
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener, createSafeVoidListener } from './_shared';

export const lspApi = {
  // ====== Process Management ======
  getProcessInfo: (): Promise<{ mode: string; processAlive: boolean; initialized: boolean }> =>
    ipcRenderer.invoke(IpcChannel.LSP_GetProcessInfo),
  isAvailable: () => ipcRenderer.invoke(IpcChannel.LSP_IsAvailable),
  getVersion: () => ipcRenderer.invoke(IpcChannel.LSP_GetVersion),
  /**
   * Start LSP server
   * @param options.virtual Virtual mode for remote projects (e.g., Overleaf) where document content is passed directly via LSP
   * @sideeffect Spawns LSP process and establishes communication channel
   */
  start: (rootPath: string, options?: { virtual?: boolean }) =>
    ipcRenderer.invoke(IpcChannel.LSP_Start, rootPath, options),
  /**
   * Stop LSP server
   * @sideeffect Terminates LSP process
   */
  stop: () => ipcRenderer.invoke(IpcChannel.LSP_Stop),
  isRunning: () => ipcRenderer.invoke(IpcChannel.LSP_IsRunning),
  isVirtualMode: () => ipcRenderer.invoke(IpcChannel.LSP_IsVirtualMode),

  // ====== Document Operations ======
  openDocument: (filePath: string, content: string, languageId?: string) =>
    ipcRenderer.invoke(IpcChannel.LSP_OpenDocument, filePath, content, languageId),
  updateDocument: (filePath: string, content: string) =>
    ipcRenderer.invoke(IpcChannel.LSP_UpdateDocument, filePath, content),
  /**
   * Incremental document update - sends only changes instead of full document
   * Significantly reduces IPC data transfer for large file edits
   * @sideeffect More efficient than full document update for large files
   */
  updateDocumentIncremental: (
    filePath: string,
    changes: Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      rangeLength?: number;
      text: string;
    }>
  ) => ipcRenderer.invoke(IpcChannel.LSP_UpdateDocumentIncremental, filePath, changes),
  closeDocument: (filePath: string) => ipcRenderer.invoke(IpcChannel.LSP_CloseDocument, filePath),
  saveDocument: (filePath: string) => ipcRenderer.invoke(IpcChannel.LSP_SaveDocument, filePath),

  // ====== Language Features ======
  getCompletions: (filePath: string, line: number, character: number) =>
    ipcRenderer.invoke(IpcChannel.LSP_GetCompletions, filePath, line, character),
  getHover: (filePath: string, line: number, character: number) =>
    ipcRenderer.invoke(IpcChannel.LSP_GetHover, filePath, line, character),
  getDefinition: (filePath: string, line: number, character: number) =>
    ipcRenderer.invoke(IpcChannel.LSP_GetDefinition, filePath, line, character),
  getReferences: (
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean
  ) =>
    ipcRenderer.invoke(IpcChannel.LSP_GetReferences, filePath, line, character, includeDeclaration),
  getDocumentSymbols: (filePath: string) => ipcRenderer.invoke(IpcChannel.LSP_GetSymbols, filePath),

  // ====== Build ======
  build: (filePath: string) => ipcRenderer.invoke(IpcChannel.LSP_Build, filePath),
  forwardSearch: (filePath: string, line: number) =>
    ipcRenderer.invoke(IpcChannel.LSP_ForwardSearch, filePath, line),

  // ====== Event Listeners ======
  /**
   * Listen to LSP diagnostics
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onDiagnostics: createSafeListener<{
    filePath: string;
    diagnostics: Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      severity?: number;
      message: string;
      source?: string;
    }>;
  }>(IpcChannel.LSP_Diagnostics),
  onInitialized: createSafeVoidListener(IpcChannel.LSP_Initialized),
  onExit: createSafeListener<{ code: number | null; signal: string | null }>(IpcChannel.LSP_Exit),
  /**
   * Listen to LSP service started event (for lazy loading tracking)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onServiceStarted: createSafeListener<{ service: 'texlab' | 'tinymist' }>(
    IpcChannel.LSP_ServiceStarted
  ),
  /**
   * Listen to LSP service stopped event
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onServiceStopped: createSafeListener<{ service: 'texlab' | 'tinymist' }>(
    IpcChannel.LSP_ServiceStopped
  ),
  /**
   * Listen to LSP service restarted event (when TexLab/Tinymist crashes and restarts individually)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onServiceRestarted: createSafeListener<{ service: 'texlab' | 'tinymist' }>(
    IpcChannel.LSP_ServiceRestarted
  ),

  // ====== High-Performance MessagePort Direct Channel API ======

  /**
   * Request direct communication channel with LSP process
   * Success triggers onDirectChannel event
   *
   * Use cases:
   * - Completion requests requiring ultra-low latency
   * - High-frequency document updates
   *
   * Note: Only available in UtilityProcess mode
   * @sideeffect Establishes MessagePort channel for direct communication
   */
  requestDirectChannel: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.LSP_RequestDirectChannel),

  /**
   * Listen to direct channel establishment event
   * Callback receives MessagePort for direct communication with LSP process
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onDirectChannel: (callback: (port: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ..._args: unknown[]) => {
      // MessagePort is passed via event.ports
      const ports = (_event as unknown as { ports?: unknown[] }).ports;
      if (ports && ports.length > 0) {
        callback(ports[0]);
      }
    };
    ipcRenderer.on(IpcChannel.LSP_DirectChannel, handler);
    return () => ipcRenderer.removeListener(IpcChannel.LSP_DirectChannel, handler);
  },

  /**
   * Listen to LSP process recovery event (auto-restart after crash)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onRecovered: createSafeVoidListener(IpcChannel.LSP_Recovered),

  /**
   * Listen to MessagePort direct channel closed event (can re-request requestDirectChannel)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onDirectChannelClosed: createSafeVoidListener(IpcChannel.LSP_DirectChannelClosed),

  // ====== Extended LSP API ======

  isTexLabAvailable: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.LSP_IsTexLabAvailable),

  isTinymistAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.LSP_IsTinymistAvailable),

  checkAvailability: (): Promise<{
    texlab: boolean;
    tinymist: boolean;
    texlabVersion?: string;
    tinymistVersion?: string;
  }> => ipcRenderer.invoke(IpcChannel.LSP_CheckAvailability),

  getTexLabVersion: (): Promise<string | undefined> =>
    ipcRenderer.invoke(IpcChannel.LSP_GetTexLabVersion),

  getTinymistVersion: (): Promise<string | undefined> =>
    ipcRenderer.invoke(IpcChannel.LSP_GetTinymistVersion),

  /**
   * Start all LSP services and return detailed results
   * @sideeffect Spawns both TexLab and Tinymist processes
   */
  startAll: (
    rootPath: string,
    options?: { virtual?: boolean }
  ): Promise<{ texlab: boolean; tinymist: boolean }> =>
    ipcRenderer.invoke(IpcChannel.LSP_StartAll, rootPath, options),

  /**
   * Start TexLab individually
   * @sideeffect Spawns TexLab process
   */
  startTexLab: (rootPath: string, options?: { virtual?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.LSP_StartTexLab, rootPath, options),

  /**
   * Start Tinymist individually
   * @sideeffect Spawns Tinymist process
   */
  startTinymist: (rootPath: string, options?: { virtual?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.LSP_StartTinymist, rootPath, options),

  /**
   * Export Typst PDF (Tinymist)
   * @sideeffect Generates PDF file on disk
   */
  exportTypstPdf: (filePath: string): Promise<{ success: boolean; pdfPath?: string }> =>
    ipcRenderer.invoke(IpcChannel.LSP_ExportTypstPdf, filePath),

  formatTypst: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.LSP_FormatTypst, filePath),

  /**
   * Listen to LSP error events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onError: createSafeListener<{ message: string; code?: number }>(IpcChannel.LSP_Error),
};
