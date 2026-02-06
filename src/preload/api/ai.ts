/**
 * @file AI API - AI Service API Module
 * @description Provides IPC interfaces for AI configuration, chat, polishing, completion
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

  /**
   * Polish text with optional RAG enhancement from knowledge base
   * @sideeffect May trigger knowledge base search if knowledgeBaseId is provided
   */
  polish: (text: string, knowledgeBaseId?: string) =>
    ipcRenderer.invoke(IpcChannel.AI_Polish, text, knowledgeBaseId),

  chat: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke(IpcChannel.AI_Chat, messages),

  chatStream: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke(IpcChannel.AI_ChatStream, messages),

  /**
   * Listen to streaming response chunks
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onStreamChunk: createSafeListener<{ type: string; content?: string; error?: string }>(
    IpcChannel.AI_StreamChunk
  ),

  generateFormula: (description: string) =>
    ipcRenderer.invoke(IpcChannel.AI_GenerateFormula, description),

  review: (content: string) => ipcRenderer.invoke(IpcChannel.AI_Review, content),

  testConnection: () => ipcRenderer.invoke(IpcChannel.AI_TestConnection),

  stopGeneration: () => ipcRenderer.invoke(IpcChannel.AI_StopGeneration),

  isGenerating: () => ipcRenderer.invoke(IpcChannel.AI_IsGenerating),

  fetchModels: (baseUrl: string, apiKey?: string) =>
    ipcRenderer.invoke(IpcChannel.AI_FetchModels, baseUrl, apiKey),
};
