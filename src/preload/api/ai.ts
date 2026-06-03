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

  // ====== Ctrl+K Inline Edit ======

  inlineEditStart: (params: {
    instruction: string;
    selectedText: string;
    language: string;
    fileLabel?: string;
    surroundingContext?: string;
  }): Promise<{ turnId: string }> => ipcRenderer.invoke(IpcChannel.AI_InlineEditStart, params),

  inlineEditCancel: (turnId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannel.AI_InlineEditCancel, turnId),

  onInlineEditDelta: createSafeListener<{ turnId: string; delta: string }>(
    IpcChannel.AI_InlineEditDelta
  ),
  onInlineEditComplete: createSafeListener<{ turnId: string; fullText: string }>(
    IpcChannel.AI_InlineEditComplete
  ),
  onInlineEditError: createSafeListener<{
    turnId: string;
    message: string;
    code?: 'aborted' | 'not_configured' | 'provider_error';
  }>(IpcChannel.AI_InlineEditError),
};
