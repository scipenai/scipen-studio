/**
 * @file PDFWorkerClient - PDF Worker Client
 * @description Wraps pdf.worker communication, provides Promise API for PDF parsing
 * @depends worker_threads, workerUtils
 */

import { Worker } from 'worker_threads';
import { WorkerRestartManager, delay, getWorkerPath } from './workerUtils';

// ====== Types ======

export interface PDFProcessOptions {
  extractImages?: boolean;
  pageRange?: [number, number];
}

export interface ChunkingConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
}

export interface ChunkData {
  content: string;
  chunkType: string;
  metadata: Record<string, any>;
}

export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  year?: number;
  journal?: string;
  doi?: string;
  pageCount?: number;
  [key: string]: any;
}

export interface PDFParseResult {
  success: boolean;
  chunks: ChunkData[];
  metadata?: DocumentMetadata;
  error?: string;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

// ====== PDFWorkerClient ======

/** Distinguishes concurrency limit errors from other errors */
export class PDFWorkerBusyError extends Error {
  constructor(activeCount: number, maxCount: number) {
    super(`PDF Worker busy (${activeCount}/${maxCount}), please retry later`);
    this.name = 'PDFWorkerBusyError';
  }
}

export class PDFWorkerClient {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private restartManager = new WorkerRestartManager('PDFWorkerClient');
  private isRestarting = false;

  // 5 minutes - large PDFs may need more time
  private defaultTimeout = 5 * 60 * 1000;

  // ====== Concurrency Control ======

  private activeParseCount = 0;
  // Limit concurrent parses to prevent OOM with large files
  private readonly maxConcurrentParses = 2;

  getConcurrencyStatus(): { active: number; max: number; available: boolean } {
    return {
      active: this.activeParseCount,
      max: this.maxConcurrentParses,
      available: this.activeParseCount < this.maxConcurrentParses,
    };
  }

  // ====== Initialization ======

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        const workerPath = getWorkerPath('pdf');
        console.info('[PDFWorkerClient] Worker path:', workerPath);

        this.worker = new Worker(workerPath);

        this.worker.on('message', (response: WorkerResponse) => {
          this.handleResponse(response);
        });

        this.worker.on('error', (error) => {
          console.error('[PDFWorkerClient] Worker error:', error);
          this.handleWorkerError(error);
        });

        this.worker.on('exit', (code) => {
          if (code !== 0) {
            console.error(`[PDFWorkerClient] Worker exited with code ${code}`);
            this.attemptRestart();
          }
          this.isInitialized = false;
          this.worker = null;
          this.initPromise = null;
        });

        // Send ping to test connection
        this.sendRequest('ping', {})
          .then(() => {
            this.isInitialized = true;
            this.restartManager.reset();
            console.info('[PDFWorkerClient] Worker initialized successfully');
            resolve();
          })
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });

    return this.initPromise;
  }

  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      console.error('[PDFWorkerClient] Max restart attempts reached');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      console.info('[PDFWorkerClient] Attempting Worker restart...');
      await this.initialize();
      console.info('[PDFWorkerClient] ✓ Worker restart successful');
    } catch (error) {
      console.error('[PDFWorkerClient] Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  // ====== Message Handling ======

  private handleResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(`[PDFWorkerClient] Received response for unknown request: ${response.id}`);
      return;
    }

    this.pendingRequests.delete(response.id);

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || 'Unknown error'));
    }
  }

  private handleWorkerError(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private sendRequest<T>(type: string, payload: any, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = `pdf-${++this.requestId}`;
      const timeoutMs = timeout ?? this.defaultTimeout;

      const pending: PendingRequest = { resolve, reject };

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, pending);

      this.worker.postMessage({ id, type, payload });
    });
  }

  // ====== Public API ======

  /**
   * Parse PDF file with concurrency control.
   *
   * Why concurrency limit? Prevents Worker OOM when processing multiple large files.
   */
  async parsePDF(
    filePath: string,
    options?: PDFProcessOptions,
    chunkingConfig?: Partial<ChunkingConfig>,
    abortId?: string
  ): Promise<PDFParseResult> {
    if (this.activeParseCount >= this.maxConcurrentParses) {
      console.warn(
        `[PDFWorkerClient] Concurrency limit reached (${this.activeParseCount}/${this.maxConcurrentParses})`
      );
      // Return error for TaskQueue retry mechanism instead of throwing
      return {
        success: false,
        chunks: [],
        error: `PDF Worker busy (${this.activeParseCount}/${this.maxConcurrentParses}), please retry later`,
      };
    }

    await this.initialize();

    this.activeParseCount++;
    console.info(
      `[PDFWorkerClient] Starting parse, active: ${this.activeParseCount}/${this.maxConcurrentParses}`
    );

    try {
      const result = await this.sendRequest<{ chunks: ChunkData[]; metadata: DocumentMetadata }>(
        'parse',
        {
          filePath,
          options,
          chunkingConfig,
          abortId,
        }
      );

      return {
        success: true,
        chunks: result.chunks,
        metadata: result.metadata,
      };
    } catch (error) {
      return {
        success: false,
        chunks: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.activeParseCount--;
      console.info(
        `[PDFWorkerClient] Parse finished, active: ${this.activeParseCount}/${this.maxConcurrentParses}`
      );
    }
  }

  async abortParse(abortId: string): Promise<void> {
    if (!this.isInitialized) return;

    return this.sendRequest('abort', { abortId });
  }

  async close(): Promise<void> {
    this.restartManager.dispose();

    if (this.worker) {
      for (const pending of this.pendingRequests.values()) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        pending.reject(new Error('Worker is closing'));
      }
      this.pendingRequests.clear();

      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.initPromise = null;
      console.info('[PDFWorkerClient] Worker closed');
    }
  }
}

// ====== Singleton Instance ======

let pdfWorkerClientInstance: PDFWorkerClient | null = null;

export function getPDFWorkerClient(): PDFWorkerClient {
  if (!pdfWorkerClientInstance) {
    pdfWorkerClientInstance = new PDFWorkerClient();
  }
  return pdfWorkerClientInstance;
}

export async function closePDFWorkerClient(): Promise<void> {
  if (pdfWorkerClientInstance) {
    await pdfWorkerClientInstance.close();
    pdfWorkerClientInstance = null;
  }
}
