/**
 * @file Knowledge API - Knowledge Base API Module
 * @description Provides IPC interfaces for knowledge base creation, document management, retrieval, RAG
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener } from './_shared';

export const knowledgeApi = {
  initialize: (options: {
    storagePath?: string;
    embeddingApiKey?: string;
    embeddingBaseUrl?: string;
    embeddingModel?: string;
    visionApiKey?: string;
    whisperApiKey?: string;
  }) => ipcRenderer.invoke(IpcChannel.Knowledge_Initialize, options),

  updateConfig: (options: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_UpdateConfig, options),

  // ====== Library Management ======
  createLibrary: (params: {
    name: string;
    description?: string;
    chunkingConfig?: unknown;
    embeddingConfig?: unknown;
    retrievalConfig?: unknown;
  }) => ipcRenderer.invoke(IpcChannel.Knowledge_CreateLibrary, params),

  getLibraries: () => ipcRenderer.invoke(IpcChannel.Knowledge_GetLibraries),
  getLibrary: (id: string) => ipcRenderer.invoke(IpcChannel.Knowledge_GetLibrary, id),
  updateLibrary: (id: string, updates: unknown) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_UpdateLibrary, id, updates),
  deleteLibrary: (id: string) => ipcRenderer.invoke(IpcChannel.Knowledge_DeleteLibrary, id),

  // ====== Document Management ======
  addDocument: (
    libraryId: string,
    filePath: string,
    options?: {
      bibKey?: string;
      citationText?: string;
      metadata?: unknown;
      processImmediately?: boolean;
    }
  ) => ipcRenderer.invoke(IpcChannel.Knowledge_AddDocument, libraryId, filePath, options),

  addText: (
    libraryId: string,
    content: string,
    options?: {
      title?: string;
      mediaType?: string;
      bibKey?: string;
      metadata?: unknown;
    }
  ) => ipcRenderer.invoke(IpcChannel.Knowledge_AddText, libraryId, content, options),

  getDocument: (id: string) => ipcRenderer.invoke(IpcChannel.Knowledge_GetDocument, id),
  getDocuments: (libraryId: string) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_GetDocuments, libraryId),
  deleteDocument: (id: string) => ipcRenderer.invoke(IpcChannel.Knowledge_DeleteDocument, id),
  reprocessDocument: (documentId: string) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_ReprocessDocument, documentId),

  // ====== Retrieval ======
  search: (options: {
    query: string;
    libraryIds?: string[];
    topK?: number;
    scoreThreshold?: number;
    retrieverType?: 'vector' | 'keyword' | 'hybrid';
  }) => ipcRenderer.invoke(IpcChannel.Knowledge_Search, options),

  query: (
    question: string,
    libraryIds?: string[],
    options?: {
      topK?: number;
      includeContext?: boolean;
    }
  ) => ipcRenderer.invoke(IpcChannel.Knowledge_Query, question, libraryIds, options),

  // ============ Task Management ============
  getTask: (taskId: string) => ipcRenderer.invoke(IpcChannel.Knowledge_GetTask, taskId),
  getQueueStats: () => ipcRenderer.invoke(IpcChannel.Knowledge_GetQueueStats),

  testEmbedding: () => ipcRenderer.invoke(IpcChannel.Knowledge_TestEmbedding),

  // ============ Diagnostics ============
  getDiagnostics: (libraryId?: string) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_Diagnostics, libraryId),
  rebuildFTSIndex: () => ipcRenderer.invoke(IpcChannel.Knowledge_RebuildFTS),
  generateMissingEmbeddings: (libraryId?: string) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_GenerateEmbeddings, libraryId),

  // ============ Advanced Retrieval Config ============
  getAdvancedConfig: () => ipcRenderer.invoke(IpcChannel.Knowledge_GetAdvancedConfig),
  setAdvancedConfig: (config: {
    enableQueryRewrite?: boolean;
    enableRerank?: boolean;
    enableContextRouting?: boolean;
    enableBilingualSearch?: boolean;
    rerankProvider?: 'dashscope' | 'openai' | 'cohere' | 'jina' | 'local';
    rerankModel?: string;
  }) => ipcRenderer.invoke(IpcChannel.Knowledge_SetAdvancedConfig, config),

  // ============ Enhanced Search ============
  searchEnhanced: (options: {
    query: string;
    libraryIds?: string[];
    topK?: number;
    scoreThreshold?: number;
    retrieverType?: 'vector' | 'keyword' | 'hybrid';
    enableQueryRewrite?: boolean;
    enableRerank?: boolean;
    enableContextRouting?: boolean;
    conversationHistory?: Array<{ role: string; content: string }>;
  }) => ipcRenderer.invoke(IpcChannel.Knowledge_SearchEnhanced, options),

  // File selection
  selectFiles: (options?: { mediaTypes?: string[]; multiple?: boolean }) =>
    ipcRenderer.invoke(IpcChannel.Knowledge_SelectFiles, options),

  // ============ Event Listeners ============
  /**
   * Listen to knowledge base events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onEvent: createSafeListener<{
    type: string;
    timestamp: number;
    data: unknown;
  }>(IpcChannel.Knowledge_Event),

  /**
   * Listen to task progress events (for upload/delete progress UI)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onTaskProgress: createSafeListener<{
    taskId: string;
    progress: number;
    status: string;
    message?: string;
    filename?: string;
    taskType?: 'upload' | 'delete';
  }>(IpcChannel.Knowledge_TaskProgress),
};
