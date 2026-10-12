/**
 * @file PDFWorkerClient - PDF Worker Client
 * @description Wraps pdf.worker communication, provides Promise API for PDF parsing
 * @depends worker_threads, workerUtils, BaseWorkerClient
 */

import { BaseWorkerClient } from './BaseWorkerClient';

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
  metadata: Record<string, unknown>;
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
  [key: string]: unknown;
}

export interface PDFParseResult {
  success: boolean;
  chunks: ChunkData[];
  metadata?: DocumentMetadata;
  error?: string;
}

// ====== PDFWorkerClient ======

/** Distinguishes concurrency limit errors from other errors */
export class PDFWorkerBusyError extends Error {
  constructor(activeCount: number, maxCount: number) {
    super(`PDF Worker busy (${activeCount}/${maxCount}), please retry later`);
    this.name = 'PDFWorkerBusyError';
  }
}

export class PDFWorkerClient extends BaseWorkerClient {
  // 5 minutes - large PDFs may need more time
  private static readonly DEFAULT_TIMEOUT = 5 * 60 * 1000;

  // ====== Concurrency Control ======

  private activeParseCount = 0;
  // Limit concurrent parses to prevent OOM with large files
  private readonly maxConcurrentParses = 2;

  constructor() {
    super({
      name: 'PDFWorkerClient',
      workerKind: 'pdf',
      idPrefix: 'pdf',
      defaultTimeout: PDFWorkerClient.DEFAULT_TIMEOUT,
      pingOnInit: true,
      rejectPendingOnAbnormalExit: false,
    });
  }

  /** PDF worker only exchanges responses — nothing to intercept. */
  protected tryHandleMessage(_message: unknown): boolean {
    return false;
  }

  getConcurrencyStatus(): { active: number; max: number; available: boolean } {
    return {
      active: this.activeParseCount,
      max: this.maxConcurrentParses,
      available: this.activeParseCount < this.maxConcurrentParses,
    };
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
    await this.closeWorker('Worker is closing');
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
