/**
 * @file AI API - AI Service API Module
 * @description Provides IPC interfaces for AI configuration, chat, completion
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener } from './_shared';

export const aiApi = {
  updateConfig: (config: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    completionModel?: string;
    completionApiKey?: string;
    completionBaseUrl?: string;
  }) => ipcRenderer.invoke(IpcChannel.AI_UpdateConfig, config),

  isConfigured: () => ipcRenderer.invoke(IpcChannel.AI_IsConfigured),

  completion: (context: string) => ipcRenderer.invoke(IpcChannel.AI_Completion, context),

  chatStream: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke(IpcChannel.AI_ChatStream, messages),

  onStreamChunk: createSafeListener<{ type: string; content?: string; error?: string }>(
    IpcChannel.AI_StreamChunk
  ),

  testConnection: () => ipcRenderer.invoke(IpcChannel.AI_TestConnection),

  stopGeneration: () => ipcRenderer.invoke(IpcChannel.AI_StopGeneration),

  isGenerating: () => ipcRenderer.invoke(IpcChannel.AI_IsGenerating),

  fetchModels: (baseUrl: string, apiKey?: string) =>
    ipcRenderer.invoke(IpcChannel.AI_FetchModels, baseUrl, apiKey),
};
