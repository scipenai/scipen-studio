/**
 * @file Agent API - CLI Tool Agent API Module
 * @description Provides IPC interfaces for PDF2LaTeX, paper review, Paper2Beamer and other CLI tools
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener } from './_shared';

export const agentApi = {
  getAvailable: () => ipcRenderer.invoke(IpcChannel.Agent_GetAvailable),
  pdf2latex: (
    inputFile: string,
    config?: { outputFile?: string; concurrent?: number; timeout?: number }
  ) => ipcRenderer.invoke(IpcChannel.Agent_PDF2LaTeX, inputFile, config),
  reviewPaper: (inputFile: string, timeout?: number) =>
    ipcRenderer.invoke(IpcChannel.Agent_Review, inputFile, timeout),
  paper2beamer: (
    inputFile: string,
    config?: { duration?: number; template?: string; output?: string; timeout?: number }
  ) => ipcRenderer.invoke(IpcChannel.Agent_Paper2Beamer, inputFile, config),
  listTemplates: () => ipcRenderer.invoke(IpcChannel.Agent_ListTemplates),
  killCurrentProcess: () => ipcRenderer.invoke(IpcChannel.Agent_Kill),
  /**
   * Syncs VLM configuration to ~/.scipen/config.json for CLI tools to read
   * @sideeffect Writes configuration file to disk
   */
  syncVLMConfig: (vlmConfig: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
  }) => ipcRenderer.invoke(IpcChannel.Agent_SyncVLMConfig, vlmConfig),
  /**
   * Creates a temporary file (used for remote Overleaf file review scenarios)
   * @sideeffect Creates a file on disk
   */
  createTempFile: (fileName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.Agent_CreateTempFile, fileName, content),
  onProgress: createSafeListener<{ type: string; message: string; progress: number }>(
    IpcChannel.Agent_Progress
  ),
};
