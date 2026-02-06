/**
 * @file PDFProcessor - PDF Document Processor
 * @description Uses PDFWorkerClient to parse PDF in Worker thread, avoiding main process blocking
 * @depends PDFWorkerClient, BaseProcessor
 */

import * as path from 'path';
import { type PDFParseResult, getPDFWorkerClient } from '../../../workers/PDFWorkerClient';
import type {
  ChunkData,
  ChunkType,
  DocumentMetadata,
  PDFProcessOptions,
  ProcessorResult,
} from '../types';
import { BaseProcessor, type ProcessorContext } from './BaseProcessor';

/** PDF parsing timeout (milliseconds) - prevents corrupted PDFs from hanging tasks indefinitely */
const PDF_PARSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Timeout Promise helper function
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export class PDFProcessor extends BaseProcessor {
  getSupportedExtensions(): string[] {
    return ['.pdf'];
  }

  async process(context: ProcessorContext): Promise<ProcessorResult> {
    try {
      const { filePath, filename, options } = context;
      const pdfOptions = options as PDFProcessOptions;

      // Get effective chunking configuration (prefer library-level config)
      const effectiveConfig = this.getEffectiveConfig(options);

      // Use Worker to parse PDF (doesn't block main process)
      const workerClient = getPDFWorkerClient();

      // Use timeout wrapper to prevent corrupted PDFs from hanging tasks indefinitely
      const parsePromise = workerClient.parsePDF(
        filePath,
        {
          extractImages: pdfOptions?.extractImages,
          pageRange: pdfOptions?.pageRange,
        },
        {
          chunkSize: effectiveConfig.chunkSize,
          chunkOverlap: effectiveConfig.chunkOverlap,
          separators: effectiveConfig.separators,
        }
      );

      const result: PDFParseResult = await withTimeout(
        parsePromise,
        PDF_PARSE_TIMEOUT_MS,
        `PDF parsing timed out after ${PDF_PARSE_TIMEOUT_MS / 1000} seconds. The file may be corrupted or too large.`
      );

      if (!result.success) {
        return {
          success: false,
          chunks: [],
          error: result.error || 'PDF parsing failed',
        };
      }

      // Convert chunk format (Worker returns format consistent with local format)
      const chunks: ChunkData[] = result.chunks.map((chunk) => ({
        content: chunk.content,
        chunkType: chunk.chunkType as ChunkType,
        metadata: chunk.metadata,
      }));

      // Extract metadata
      const metadata: DocumentMetadata = {
        title: result.metadata?.title || path.basename(filename, '.pdf'),
        authors: result.metadata?.authors,
        abstract: result.metadata?.abstract,
        keywords: result.metadata?.keywords,
        year: result.metadata?.year,
        journal: result.metadata?.journal,
        doi: result.metadata?.doi,
        pageCount: result.metadata?.pageCount,
      };

      return {
        success: true,
        chunks,
        metadata,
      };
    } catch (error) {
      console.error('[PDFProcessor] Error processing PDF:', error);
      return {
        success: false,
        chunks: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate BibTeX citation format
   */
  static generateBibTeX(metadata: DocumentMetadata, bibKey?: string): string {
    const key = bibKey || PDFProcessor.generateBibKey(metadata);
    const authors = metadata.authors?.join(' and ') || 'Unknown';

    return `@article{${key},
  title = {${metadata.title || 'Untitled'}},
  author = {${authors}},
  year = {${metadata.year || new Date().getFullYear()}},
  journal = {${metadata.journal || ''}},
  doi = {${metadata.doi || ''}}
}`;
  }

  /**
   * Generate BibTeX Key
   */
  static generateBibKey(metadata: DocumentMetadata): string {
    const firstAuthor = metadata.authors?.[0]?.split(' ').pop() || 'unknown';
    const year = metadata.year || new Date().getFullYear();
    const titleWord = metadata.title?.split(' ')[0]?.toLowerCase() || 'paper';
    return `${firstAuthor.toLowerCase()}${year}${titleWord}`;
  }
}
