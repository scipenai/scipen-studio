/**
 * @file KnowledgeBaseService.ts - Knowledge Base Service
 * @description Encapsulates knowledge base document management, indexing, and search business logic
 * @depends IPC (api.knowledge), ProjectService
 */

import {
  CancellationError,
  type CancellationToken,
  CancellationTokenSource,
  Disposable,
  Emitter,
  EventCoalescer,
} from '../../../../../shared/utils';
import { api } from '../../api';
import type { KnowledgeBase } from '../../types';
import { getProjectService } from './ProjectService';
import { getSettingsService } from './SettingsService';

// ====== Type Definitions ======

export interface DocumentInfo {
  id: string;
  filename: string;
  filePath: string;
  mediaType: string;
  fileSize: number;
  processStatus: string;
  createdAt: string; // ISO 8601 string from DTO
  metadata?: {
    title?: string;
    abstract?: string;
    authors?: string[];
    keywords?: string[];
  };
}

export interface UploadTask {
  id: string;
  filename: string;
  libraryId: string;
  progress: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  message?: string;
}

export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SearchOptions {
  query: string;
  libraryIds?: string[];
  topK?: number;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ====== Service Implementation ======

export class KnowledgeBaseService extends Disposable {
  private static _instance: KnowledgeBaseService | null = null;

  private readonly _onLibrariesChanged = this._register(new Emitter<KnowledgeBase[]>());
  readonly onLibrariesChanged = this._onLibrariesChanged.event;

  private readonly _onDocumentsChanged = this._register(
    new Emitter<{ libraryId: string; documents: DocumentInfo[] }>()
  );
  readonly onDocumentsChanged = this._onDocumentsChanged.event;

  private readonly _onTaskProgress = this._register(new Emitter<UploadTask>());
  readonly onTaskProgress = this._onTaskProgress.event;

  private readonly _onError = this._register(new Emitter<string>());
  readonly onError = this._onError.event;

  private _libraries: KnowledgeBase[] = [];
  private _documentCache = new Map<string, DocumentInfo[]>();
  private _activeTasks = new Map<string, UploadTask>();
  private _unsubscribeTaskProgress: (() => void) | null = null;

  /**
   * Document change event coalescer
   *
   * When there are many document changes in a short time (e.g., batch upload, deletion),
   * merges these changes into a single `onDocumentsChanged` event,
   * avoiding frequent UI list refreshes.
   *
   * Coalescing strategy: Group by libraryId, merge DocumentInfo lists
   */
  private readonly _documentsChangeCoalescer = this._register(
    new EventCoalescer<{ libraryId: string; documents: DocumentInfo[] }>(200)
  );

  /**
   * Current search CancellationTokenSource
   *
   * Used to cancel ongoing search operations. When user initiates a new search,
   * the previous unfinished search is automatically cancelled, releasing resources.
   */
  private _currentSearchCts: CancellationTokenSource | null = null;

  private constructor() {
    super();
    this._setupTaskProgressListener();
    this._setupDocumentsCoalescer();
    this._setupKnowledgeEventListener();
  }

  private _setupKnowledgeEventListener(): void {
    const unsubscribe = api.knowledge.onEvent((event) => {
      if (event.type === 'document:processed') {
        const data = event.data as { libraryId: string; documentId: string };
        if (data.libraryId) {
          this.loadDocuments(data.libraryId).catch(console.error);
          this.loadLibraries().catch(console.error);
        }
      }
    });

    this._register({ dispose: unsubscribe });
  }

  private _setupDocumentsCoalescer(): void {
    this._register(
      this._documentsChangeCoalescer.onFlush((events) => {
        const groups = new Map<string, DocumentInfo[]>();

        for (const event of events) {
          groups.set(event.libraryId, event.documents);
        }

        for (const [libraryId, documents] of groups) {
          this._onDocumentsChanged.fire({ libraryId, documents });
        }
      })
    );
  }

  static getInstance(): KnowledgeBaseService {
    if (!KnowledgeBaseService._instance) {
      KnowledgeBaseService._instance = new KnowledgeBaseService();
    }
    return KnowledgeBaseService._instance;
  }

  private _setupTaskProgressListener(): void {
    this._unsubscribeTaskProgress = api.knowledge.onTaskProgress((event) => {
      const task = this._activeTasks.get(event.taskId);
      if (task) {
        const updatedTask: UploadTask = {
          ...task,
          progress: event.progress,
          status: event.status as UploadTask['status'],
          message: event.message,
        };
        this._activeTasks.set(event.taskId, updatedTask);
        this._onTaskProgress.fire(updatedTask);

        if (event.status === 'completed' || event.status === 'failed') {
          setTimeout(() => this._activeTasks.delete(event.taskId), 5000);
        }
      }
    });
  }

  override dispose(): void {
    this._unsubscribeTaskProgress?.();
    if (this._currentSearchCts) {
      this._currentSearchCts.cancel();
      this._currentSearchCts.dispose();
      this._currentSearchCts = null;
    }
    super.dispose();
  }

  // ====== Knowledge Base CRUD ======

  async loadLibraries(): Promise<KnowledgeBase[]> {
    try {
      const libs = await api.knowledge.getLibraries();
      this._libraries = (libs as unknown[]).map((lib: unknown) => {
        const l = lib as Record<string, unknown>;
        return {
          id: l.id as string,
          name: l.name as string,
          description: (l.description as string) || '',
          documentCount: (l.documentCount as number) || 0,
          createdAt: l.createdAt as string,
          updatedAt: l.updatedAt as string,
        };
      });

      getProjectService().setKnowledgeBases(this._libraries);
      this._onLibrariesChanged.fire(this._libraries);
      return this._libraries;
    } catch (error) {
      this._onError.fire(`Failed to load knowledge bases: ${error}`);
      return [];
    }
  }

  async createLibrary(name: string, description?: string): Promise<OperationResult<KnowledgeBase>> {
    const ragSettings = getSettingsService().getSettings().rag;
    const chunkingConfig = {
      chunkSize: ragSettings?.local?.chunkSize || 512,
      chunkOverlap: ragSettings?.local?.chunkOverlap || 50,
    };

    try {
      const newLib = await api.knowledge.createLibrary({ name, description, chunkingConfig });
      const kb: KnowledgeBase = {
        id: newLib.id,
        name: newLib.name,
        description: newLib.description || '',
        documentCount: 0,
        createdAt: newLib.createdAt || new Date().toISOString(),
        updatedAt: newLib.updatedAt || new Date().toISOString(),
      };

      this._libraries = [...this._libraries, kb];
      getProjectService().setKnowledgeBases(this._libraries);
      this._onLibrariesChanged.fire(this._libraries);

      return { success: true, data: kb };
    } catch (error) {
      const message = `Failed to create knowledge base: ${error}`;
      this._onError.fire(message);
      return { success: false, error: message };
    }
  }

  async deleteLibrary(id: string): Promise<OperationResult> {
    const kb = this._libraries.find((k) => k.id === id);
    const kbName = kb?.name || 'Knowledge Base';

    const confirmed = await api.dialog.confirm(
      `Are you sure you want to delete "${kbName}"? All documents will be permanently deleted.`,
      'Delete Knowledge Base'
    );

    if (!confirmed) {
      return { success: false, error: 'User cancelled' };
    }

    const previousLibraries = [...this._libraries];
    this._libraries = this._libraries.filter((k) => k.id !== id);
    getProjectService().setKnowledgeBases(this._libraries);
    this._onLibrariesChanged.fire(this._libraries);

    try {
      await api.knowledge.deleteLibrary(id);
      this._documentCache.delete(id);
      return { success: true };
    } catch (error) {
      this._libraries = previousLibraries;
      getProjectService().setKnowledgeBases(previousLibraries);
      this._onLibrariesChanged.fire(previousLibraries);

      const message = `Failed to delete knowledge base: ${error}`;
      this._onError.fire(message);
      return { success: false, error: message };
    }
  }

  // ====== Document Management ======

  async loadDocuments(libraryId: string): Promise<DocumentInfo[]> {
    try {
      const docs = await api.knowledge.getDocuments(libraryId);
      const documents: DocumentInfo[] = (docs as unknown[]).map((doc: unknown) => {
        const d = doc as Record<string, unknown>;
        return {
          id: d.id as string,
          filename: d.filename as string,
          filePath: d.filePath as string,
          mediaType: d.mediaType as string,
          fileSize: d.fileSize as number,
          processStatus: d.processStatus as string,
          createdAt: d.createdAt as string,
          metadata: d.metadata as DocumentInfo['metadata'],
        };
      });

      this._documentCache.set(libraryId, documents);

      this._documentsChangeCoalescer.add({ libraryId, documents });

      return documents;
    } catch (error) {
      this._onError.fire(`Failed to load documents: ${error}`);
      return [];
    }
  }

  async deleteDocument(docId: string, libraryId: string): Promise<OperationResult> {
    const confirmed = await api.dialog.confirm(
      'Are you sure you want to delete this document? Related vectors and indexes will also be cleared.',
      'Delete Document'
    );

    if (!confirmed) {
      return { success: false, error: 'User cancelled' };
    }

    try {
      await api.knowledge.deleteDocument(docId);

      const cached = this._documentCache.get(libraryId);
      if (cached) {
        const updated = cached.filter((d) => d.id !== docId);
        this._documentCache.set(libraryId, updated);
        this._documentsChangeCoalescer.add({ libraryId, documents: updated });
      }

      return { success: true };
    } catch (error) {
      const message = `Failed to delete document: ${error}`;
      this._onError.fire(message);
      return { success: false, error: message };
    }
  }

  // ====== Document Upload ======

  async selectAndUploadFiles(libraryId: string): Promise<OperationResult<string[]>> {
    try {
      const filePaths = await api.knowledge.selectFiles({
        mediaTypes: ['pdf', 'text', 'image', 'audio'],
      });

      if (!filePaths || filePaths.length === 0) {
        return { success: false, error: 'No files selected' };
      }

      const taskIds: string[] = [];

      for (const filePath of filePaths) {
        const filename = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
        const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        const task: UploadTask = {
          id: taskId,
          filename,
          libraryId,
          progress: 0,
          status: 'pending',
        };

        this._activeTasks.set(taskId, task);
        this._onTaskProgress.fire(task);

        this._uploadFile(libraryId, filePath, taskId);
        taskIds.push(taskId);
      }

      return { success: true, data: taskIds };
    } catch (error) {
      const message = `Failed to select files: ${error}`;
      this._onError.fire(message);
      return { success: false, error: message };
    }
  }

  private async _uploadFile(libraryId: string, filePath: string, taskId: string): Promise<void> {
    const task = this._activeTasks.get(taskId);
    if (!task) return;

    try {
      this._updateTask(taskId, { status: 'processing', progress: 10, message: 'Uploading...' });

      const result = await api.knowledge.addDocument(libraryId, filePath, {
        processImmediately: true,
      });

      if (result.taskId) {
        this._activeTasks.set(result.taskId, { ...task, id: result.taskId });
        this._activeTasks.delete(taskId);
      } else {
        this._updateTask(taskId, {
          status: 'completed',
          progress: 100,
          message: 'Upload completed',
        });
      }
    } catch (error) {
      this._updateTask(taskId, {
        status: 'failed',
        progress: 0,
        message: `Upload failed: ${error}`,
      });
    }
  }

  private _updateTask(taskId: string, updates: Partial<UploadTask>): void {
    const task = this._activeTasks.get(taskId);
    if (task) {
      const updated = { ...task, ...updates };
      this._activeTasks.set(taskId, updated);
      this._onTaskProgress.fire(updated);
    }
  }

  getActiveTasks(): UploadTask[] {
    return Array.from(this._activeTasks.values());
  }

  hasActiveTasks(): boolean {
    return Array.from(this._activeTasks.values()).some(
      (t) => t.status === 'pending' || t.status === 'processing'
    );
  }

  // ====== Knowledge Base Search ======

  /**
   * Search knowledge base (supports cancellation)
   *
   * When user rapidly enters multiple search terms, this method automatically cancels
   * the previous unfinished search, avoiding invalid computation and network requests.
   */
  async search(options: SearchOptions, token?: CancellationToken): Promise<SearchResult[]> {
    if (this._currentSearchCts) {
      this._currentSearchCts.cancel();
      this._currentSearchCts.dispose();
    }

    const ownCts = token ? null : new CancellationTokenSource();
    this._currentSearchCts = ownCts;
    const effectiveToken = token || ownCts!.token;

    try {
      if (effectiveToken.isCancellationRequested) {
        throw new CancellationError();
      }

      const result = await api.knowledge.search({
        query: options.query,
        libraryIds: options.libraryIds,
        topK: options.topK || 5,
      });

      if (effectiveToken.isCancellationRequested) {
        throw new CancellationError();
      }

      return (result.results || []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        content: r.content as string,
        score: r.score as number,
        metadata: r.metadata as Record<string, unknown>,
      }));
    } catch (error) {
      if (error instanceof CancellationError) {
        return [];
      }
      this._onError.fire(`Search failed: ${error}`);
      return [];
    } finally {
      if (ownCts && this._currentSearchCts === ownCts) {
        this._currentSearchCts = null;
        ownCts.dispose();
      }
    }
  }

  cancelSearch(): void {
    if (this._currentSearchCts) {
      this._currentSearchCts.cancel();
      this._currentSearchCts.dispose();
      this._currentSearchCts = null;
    }
  }
}

// ====== Exports ======

let knowledgeBaseService: KnowledgeBaseService | null = null;

export function getKnowledgeBaseService(): KnowledgeBaseService {
  if (!knowledgeBaseService) {
    knowledgeBaseService = KnowledgeBaseService.getInstance();
  }
  return knowledgeBaseService;
}

export function useKnowledgeBaseService(): KnowledgeBaseService {
  return getKnowledgeBaseService();
}
