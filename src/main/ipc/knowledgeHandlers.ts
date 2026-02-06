/**
 * @file Knowledge base IPC handlers (Type-Safe)
 * @description Handles knowledge base, vector storage, and RAG retrieval operations.
 * @depends IKnowledgeService, PathSecurityService
 * @security All file paths validated; user-selected files allowed outside project
 */

import { IpcChannel } from '@shared/ipc/channels';
import { SimpleThrottle } from '@shared/utils';
import { type BrowserWindow, dialog } from 'electron';
import { createLogger } from '../services/LoggerService';
import { type PathAccessMode, checkPathSecurity } from '../services/PathSecurityService';
import type {
  IKnowledgeService,
  InitOptions as KnowledgeInitOptions,
} from '../services/interfaces';
import type { CreateLibraryParams } from '../types/ipc';
import { createTypedHandlers } from './typedIpc';

// ====== Mappers ======

import {
  toAdvancedRetrievalConfigDTO,
  toEnhancedSearchResultDTO,
  toKnowledgeDiagnosticsDTO,
  toKnowledgeDocumentDTO,
  toKnowledgeDocumentDTOList,
  toKnowledgeLibraryDTO,
  toKnowledgeLibraryDTOList,
  toKnowledgeQueueStatsDTO,
  toKnowledgeRAGResponseDTO,
  toKnowledgeSearchResultDTOList,
  toKnowledgeTaskStatusDTO,
} from '../utils/mappers';

const logger = createLogger('KnowledgeHandlers');

// ====== Security Helpers ======

/**
 * Validate path security, throws if unsafe.
 * @remarks Knowledge base allows user-selected files outside project
 */
function assertPathSecurity(filePath: string, mode: PathAccessMode = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'user-selected');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(result.reason || 'Access denied');
  }
  return result.sanitizedPath || filePath;
}

// ====== Types ======

/** Knowledge handler dependencies (injected at registration) */
export interface KnowledgeHandlersDeps {
  /** Knowledge service getter (lazy, may not be initialized at registration time) */
  getKnowledgeService: () => IKnowledgeService;
  /** Main window getter */
  getMainWindow: () => BrowserWindow | null;
}

interface TaskProgressEvent {
  taskId: string;
  progress: number;
  status: string;
  message?: string;
  filename?: string;
  taskType?: 'upload' | 'delete';
}

// ====== Handler Registration ======

/**
 * Register knowledge base IPC handlers.
 * @sideeffect Registers handlers on ipcMain for knowledge operations
 */
export function registerKnowledgeHandlers(deps: KnowledgeHandlersDeps): void {
  const { getKnowledgeService, getMainWindow } = deps;

  let eventListenersSetup = false;

  const setupEventListeners = () => {
    if (eventListenersSetup) return;

    try {
      const knowledgeService = getKnowledgeService();

      // Throttled progress event sending - uses shared SimpleThrottle
      const progressThrottle = new SimpleThrottle(200);
      const throttledSendProgress = progressThrottle.wrap((progressEvent: TaskProgressEvent) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannel.Knowledge_TaskProgress, progressEvent);
        }
      });

      // Listen for task progress events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      knowledgeService.on('task:progress', (event: any) => {
        const progressEvent: TaskProgressEvent = {
          taskId: event.data?.taskId || event.taskId || '',
          progress: event.data?.progress || 0,
          status: event.data?.status || 'processing',
          message: event.data?.message,
          filename: event.data?.filename,
          taskType: event.data?.taskType,
        };
        throttledSendProgress(progressEvent);
      });

      // Listen for task completed events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      knowledgeService.on('task:completed', (event: any) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const progressEvent: TaskProgressEvent = {
            taskId: event.data?.taskId || event.taskId || '',
            progress: 100,
            status: 'completed',
            message: 'Processing completed',
            filename: event.data?.filename,
            taskType: event.data?.taskType,
          };
          mainWindow.webContents.send(IpcChannel.Knowledge_TaskProgress, progressEvent);
        }
      });

      // Listen for task failed events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      knowledgeService.on('task:failed', (event: any) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const progressEvent: TaskProgressEvent = {
            taskId: event.data?.taskId || event.taskId || '',
            progress: 0,
            status: 'failed',
            message: event.data?.error || 'Processing failed',
            filename: event.data?.filename,
            taskType: event.data?.taskType,
          };
          mainWindow.webContents.send(IpcChannel.Knowledge_TaskProgress, progressEvent);
        }
      });

      // Listen for generic events and forward
      knowledgeService.on('event', (event: unknown) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannel.Knowledge_Event, event);
        }
      });

      eventListenersSetup = true;
      logger.info('[KnowledgeHandlers] Event listeners setup complete');
    } catch {
      logger.warn('[KnowledgeHandlers] Failed to setup event listeners');
    }
  };

  // Delayed event listener setup
  setTimeout(setupEventListeners, 2000);

  const handlers = createTypedHandlers(
    {
      // Initialize knowledge service
      [IpcChannel.Knowledge_Initialize]: async (options) => {
        const knowledgeService = getKnowledgeService();
        try {
          await knowledgeService.initialize(options as KnowledgeInitOptions);
          return { success: true };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      // Update API config
      [IpcChannel.Knowledge_UpdateConfig]: async (options) => {
        try {
          const knowledgeService = getKnowledgeService();
          await knowledgeService.updateConfig(options as Partial<KnowledgeInitOptions>);
          return { success: true };
        } catch (error) {
          logger.error('[Main] API config update failed:', error);
          return { success: false };
        }
      },

      // Create library (uses Mapper)
      [IpcChannel.Knowledge_CreateLibrary]: async (params) => {
        const knowledgeService = getKnowledgeService();
        const lib = await knowledgeService.createLibrary(params as CreateLibraryParams);
        return toKnowledgeLibraryDTO(lib);
      },

      // Get all libraries (uses Mapper)
      [IpcChannel.Knowledge_GetLibraries]: async () => {
        const knowledgeService = getKnowledgeService();
        const libraries = await knowledgeService.getAllLibrariesAsync();
        return toKnowledgeLibraryDTOList(libraries);
      },

      // Get single library (uses Mapper)
      [IpcChannel.Knowledge_GetLibrary]: async (id) => {
        const knowledgeService = getKnowledgeService();
        const lib = await knowledgeService.getLibrary(id);
        if (!lib) return null;
        return toKnowledgeLibraryDTO(lib);
      },

      // Update library (uses Mapper)
      [IpcChannel.Knowledge_UpdateLibrary]: async (id, updates) => {
        const knowledgeService = getKnowledgeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lib = await knowledgeService.updateLibrary(id, updates as any);
        return toKnowledgeLibraryDTO(lib);
      },

      // Delete library
      [IpcChannel.Knowledge_DeleteLibrary]: async (id) => {
        const knowledgeService = getKnowledgeService();
        await knowledgeService.deleteLibrary(id);
        return { success: true };
      },

      // Add document
      [IpcChannel.Knowledge_AddDocument]: async (libraryId, filePath, options) => {
        // Path security check
        const safePath = assertPathSecurity(filePath, 'read');
        const knowledgeService = getKnowledgeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await knowledgeService.addDocument(libraryId, safePath, options as any);
        return { documentId: result.documentId, taskId: result.taskId };
      },

      // Add text content
      [IpcChannel.Knowledge_AddText]: async (libraryId, content, options) => {
        const knowledgeService = getKnowledgeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await knowledgeService.addText(libraryId, content, options as any);
        return { documentId: result.documentId, taskId: result.taskId };
      },

      // Get document (uses Mapper)
      [IpcChannel.Knowledge_GetDocument]: async (id) => {
        const knowledgeService = getKnowledgeService();
        const doc = await knowledgeService.getDocument(id);
        if (!doc) return null;
        return toKnowledgeDocumentDTO(doc);
      },

      // Get all documents in library (uses Mapper)
      [IpcChannel.Knowledge_GetDocuments]: async (libraryId) => {
        const knowledgeService = getKnowledgeService();
        const docs = await knowledgeService.getDocumentsByLibraryAsync(libraryId);
        return toKnowledgeDocumentDTOList(docs);
      },

      // Delete document
      [IpcChannel.Knowledge_DeleteDocument]: async (id) => {
        const knowledgeService = getKnowledgeService();
        await knowledgeService.deleteDocument(id);
        return { success: true };
      },

      // Reprocess document
      [IpcChannel.Knowledge_ReprocessDocument]: async (documentId) => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.reprocessDocument(documentId);
        return { taskId: result.taskId };
      },

      // Search (uses Mapper)
      [IpcChannel.Knowledge_Search]: async (options) => {
        const knowledgeService = getKnowledgeService();
        const startTime = Date.now();
        const results = await knowledgeService.search(options);
        return {
          results: toKnowledgeSearchResultDTOList(results),
          processingTime: Date.now() - startTime,
        };
      },

      // Enhanced search (uses Mapper)
      [IpcChannel.Knowledge_SearchEnhanced]: async (options) => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.searchEnhanced(options);
        return toEnhancedSearchResultDTO(result);
      },

      // RAG query (uses Mapper)
      [IpcChannel.Knowledge_Query]: async (question, libraryIds, options) => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.query(question, libraryIds, options);
        return toKnowledgeRAGResponseDTO(result);
      },

      // Get task status (uses Mapper)
      [IpcChannel.Knowledge_GetTask]: async (taskId) => {
        const knowledgeService = getKnowledgeService();
        const task = await knowledgeService.getTask(taskId);
        if (!task) return null;
        return toKnowledgeTaskStatusDTO(task);
      },

      // Get queue stats (uses Mapper)
      [IpcChannel.Knowledge_GetQueueStats]: async () => {
        const knowledgeService = getKnowledgeService();
        const stats = await knowledgeService.getQueueStats();
        return toKnowledgeQueueStatsDTO(stats);
      },

      // Test embedding service
      [IpcChannel.Knowledge_TestEmbedding]: async () => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.testEmbeddingConnection();
        return {
          success: result.success,
          message: result.message,
        };
      },

      // Get diagnostics (uses Mapper)
      [IpcChannel.Knowledge_Diagnostics]: async (libraryId) => {
        const knowledgeService = getKnowledgeService();
        const diag = await knowledgeService.getDiagnostics(libraryId);
        return toKnowledgeDiagnosticsDTO(diag);
      },

      // Rebuild FTS index
      [IpcChannel.Knowledge_RebuildFTS]: async () => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.rebuildFTSIndex();
        return { success: result.success, count: result.recordCount };
      },

      // Generate missing embeddings
      [IpcChannel.Knowledge_GenerateEmbeddings]: async (libraryId) => {
        const knowledgeService = getKnowledgeService();
        const result = await knowledgeService.generateMissingEmbeddings(libraryId);
        return { success: result.success, count: result.generated };
      },

      // Get advanced retrieval config (uses Mapper)
      [IpcChannel.Knowledge_GetAdvancedConfig]: () => {
        const knowledgeService = getKnowledgeService();
        const config = knowledgeService.getAdvancedRetrievalConfig();
        return toAdvancedRetrievalConfigDTO(config);
      },

      // Update advanced retrieval config
      [IpcChannel.Knowledge_SetAdvancedConfig]: (config) => {
        const knowledgeService = getKnowledgeService();
        // Convert DTO to domain model
        knowledgeService.setAdvancedRetrievalConfig({
          ...config,
          enableBilingualRetrieval: config.enableBilingualSearch,
        });
        return { success: true };
      },

      // Select files
      [IpcChannel.Knowledge_SelectFiles]: async (options) => {
        const mainWindow = getMainWindow();
        const filters: Array<{ name: string; extensions: string[] }> = [];

        if (options?.mediaTypes?.includes('pdf')) {
          filters.push({ name: 'PDF Documents', extensions: ['pdf'] });
        }
        if (options?.mediaTypes?.includes('audio')) {
          filters.push({
            name: 'Audio Files',
            extensions: ['mp3', 'mp4', 'm4a', 'wav', 'webm', 'ogg', 'flac'],
          });
        }
        if (options?.mediaTypes?.includes('image')) {
          filters.push({ name: 'Image Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] });
        }
        if (options?.mediaTypes?.includes('text')) {
          filters.push({ name: 'Text Files', extensions: ['txt', 'md', 'tex'] });
        }

        if (filters.length === 0) {
          filters.push({
            name: 'All Supported Files',
            extensions: [
              'pdf',
              'mp3',
              'mp4',
              'm4a',
              'wav',
              'jpg',
              'jpeg',
              'png',
              'gif',
              'txt',
              'md',
              'tex',
            ],
          });
        }

        const result = await dialog.showOpenDialog(mainWindow!, {
          properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          filters,
          title: 'Select files to add to knowledge base',
        });

        if (result.canceled) return null;
        return result.filePaths;
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Knowledge handlers registered (type-safe with mappers)');
}

// Setup knowledge base event forwarding
export function setupKnowledgeEventForwarding(
  knowledgeService: IKnowledgeService,
  getMainWindow: () => BrowserWindow | null
): void {
  knowledgeService.on('event', (event) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('knowledge:event', event);
    }
  });
}
