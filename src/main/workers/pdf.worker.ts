/**
 * @file PDF Worker
 * @description Executes PDF parsing in a separate thread. Supports large file text extraction and chunking.
 * @memory-protection File size limit (200MB), heap monitoring (reject at 80%), manual GC if available.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as v8 from 'v8';
import { parentPort } from 'worker_threads';

const isDev = process.env.NODE_ENV === 'development';
const log = {
  debug: (...args: unknown[]) => isDev && console.debug('[PDFWorker]', ...args),
  info: (...args: unknown[]) => isDev && console.info('[PDFWorker]', ...args),
  warn: (...args: unknown[]) => console.warn('[PDFWorker]', ...args),
  error: (...args: unknown[]) => console.error('[PDFWorker]', ...args),
};

// ============ Memory Protection Config ============

const MEMORY_LIMIT_MB = 512;
const MEMORY_THRESHOLD = 0.8;

function checkMemoryUsage(): { usedMB: number; limitMB: number; ok: boolean } {
  const heapStats = v8.getHeapStatistics();
  const usedMB = heapStats.used_heap_size / 1024 / 1024;
  const threshold = MEMORY_LIMIT_MB * MEMORY_THRESHOLD;

  return {
    usedMB: Math.round(usedMB * 100) / 100,
    limitMB: MEMORY_LIMIT_MB,
    ok: usedMB < threshold,
  };
}

let gcUnavailableWarned = false;

/**
 * Attempts to trigger garbage collection.
 * Requires --expose-gc flag when starting Worker. Optional - V8's auto GC is usually sufficient.
 */
function tryGC(): boolean {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
      return true;
    } catch {
      return false;
    }
  }

  // Warn once to avoid log spam
  if (!gcUnavailableWarned) {
    log.warn(
      'global.gc() not available. ' +
        'To enable manual GC, start Worker with --expose-gc flag. ' +
        'This is optional - automatic GC is usually sufficient.'
    );
    gcUnavailableWarned = true;
  }
  return false;
}

// ============ Type Definitions ============

type PingPayload = {};

interface ParsePDFPayload {
  filePath: string;
  options?: PDFProcessOptions;
  chunkingConfig?: ChunkingConfig;
  abortId?: string;
}

interface AbortPayloadType {
  abortId: string;
}

type WorkerMessage =
  | { id: string; type: 'ping'; payload: PingPayload }
  | { id: string; type: 'parse'; payload: ParsePDFPayload }
  | { id: string; type: 'abort'; payload: AbortPayloadType };

const abortControllers = new Map<string, { aborted: boolean }>();

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: { chunks: ChunkData[]; metadata: DocumentMetadata } | string;
  error?: string;
}

interface PDFProcessOptions {
  extractImages?: boolean;
  pageRange?: [number, number];
}

interface ChunkingConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
}

interface ChunkData {
  content: string;
  chunkType: string;
  metadata: Record<string, any>;
}

interface DocumentMetadata {
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

interface ProcessorResult {
  success: boolean;
  chunks: ChunkData[];
  metadata?: DocumentMetadata;
  error?: string;
}

interface PDFPageContent {
  page: number;
  text: string;
}

// ============ Default Config ============

const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 512,
  chunkOverlap: 50,
  separators: ['\n\n', '\n', '。', '.', ' '],
};

// ============ PDF Parsing ============

let pdfParse: any = null;

async function getPdfParse() {
  if (!pdfParse) {
    try {
      pdfParse = (await import('pdf-parse')).default;
    } catch (error) {
      log.error('Failed to load pdf-parse:', error);
      throw new Error('pdf-parse module not available');
    }
  }
  return pdfParse;
}

/** Cleans PDF text by fixing hyphenation, merging lines, and removing control chars. */
function cleanPDFText(text: string): string {
  return text
    .replace(/(\w)-\n(\w)/g, '$1$2') // Fix hyphenated line breaks
    .replace(/([^\n])\n([^\n])/g, '$1 $2') // Merge in-paragraph newlines
    .replace(/\n{2,}/g, '\n\n') // Preserve paragraph breaks
    .replace(/[ \t]+/g, ' ') // Remove extra whitespace
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Remove control chars
    .trim();
}

/** Extracts metadata from document content (title, abstract, DOI, year). */
function extractMetadataFromContent(text: string): Partial<DocumentMetadata> {
  const metadata: Partial<DocumentMetadata> = {};

  // Title extraction (usually early, large font)
  const lines = text.split('\n').slice(0, 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && trimmed.length < 200) {
      if (!/^(abstract|introduction|keywords|contents|figure|table)/i.test(trimmed)) {
        metadata.title = metadata.title || trimmed;
        break;
      }
    }
  }

  // Abstract extraction
  const abstractMatch = text.match(
    /abstract[:\s]*\n?([\s\S]{100,1000}?)(?=\n\n|introduction|keywords|1\.|1\s)/i
  );
  if (abstractMatch) {
    metadata.abstract = cleanPDFText(abstractMatch[1]);
  }

  // DOI extraction
  const doiMatch = text.match(/doi[:\s]*(10\.\d{4,}\/[^\s]+)/i);
  if (doiMatch) {
    metadata.doi = doiMatch[1];
  }

  // Year extraction
  const yearMatch = text.match(/(?:©|copyright|\(c\)|published)[:\s]*(\d{4})/i);
  if (yearMatch) {
    metadata.year = Number.parseInt(yearMatch[1]);
  }

  return metadata;
}

/** Splits text by character with overlap. */
function splitByCharacter(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }

  return chunks;
}

/** Merges smaller text fragments up to maxSize. */
function mergeSmallerParts(parts: string[], maxSize: number, separator: string): string[] {
  const merged: string[] = [];
  let current = '';

  for (const part of parts) {
    const testMerge = current ? current + separator + part : part;

    if (testMerge.length <= maxSize) {
      current = testMerge;
    } else {
      if (current) {
        merged.push(current);
      }
      current = part;
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

/** Chunks text using recursive separator-based splitting. */
function chunkText(
  text: string,
  chunkType: string,
  config: ChunkingConfig,
  baseMetadata: Record<string, any> = {}
): ChunkData[] {
  const chunks: ChunkData[] = [];
  const { chunkSize, chunkOverlap, separators } = config;

  const splitText = (text: string, separatorIndex = 0): string[] => {
    if (text.length <= chunkSize) {
      return [text];
    }

    if (separatorIndex >= separators.length) {
      return splitByCharacter(text, chunkSize, chunkOverlap);
    }

    const separator = separators[separatorIndex];
    const parts = text.split(separator);

    if (parts.length === 1) {
      return splitText(text, separatorIndex + 1);
    }

    const mergedParts = mergeSmallerParts(parts, chunkSize, separator);

    const result: string[] = [];
    for (const part of mergedParts) {
      if (part.length > chunkSize) {
        result.push(...splitText(part, separatorIndex + 1));
      } else {
        result.push(part);
      }
    }

    return result;
  };

  const textChunks = splitText(text.trim());
  let currentOffset = 0;

  for (let i = 0; i < textChunks.length; i++) {
    const content = textChunks[i].trim();
    if (content.length === 0) continue;

    const startOffset = text.indexOf(content, currentOffset);
    const endOffset = startOffset + content.length;

    chunks.push({
      content,
      chunkType,
      metadata: {
        ...baseMetadata,
        startOffset,
        endOffset,
        chunkLength: content.length,
      },
    });

    currentOffset = endOffset;
  }

  return chunks;
}

/** Creates chunks organized by page. */
function createPageChunks(
  pageContents: PDFPageContent[],
  config: ChunkingConfig,
  options?: PDFProcessOptions
): ChunkData[] {
  const chunks: ChunkData[] = [];
  const pageRange = options?.pageRange;

  for (let i = 0; i < pageContents.length; i++) {
    const pageNum = i + 1;

    if (pageRange) {
      if (pageNum < pageRange[0] || pageNum > pageRange[1]) {
        continue;
      }
    }

    const pageContent = pageContents[i];
    const cleanedText = cleanPDFText(pageContent.text);

    if (!cleanedText.trim()) continue;

    // Further chunk if single page content is too long
    if (cleanedText.length > config.chunkSize * 2) {
      const subChunks = chunkText(cleanedText, 'text', config, {
        page: pageNum,
        sourceType: 'pdf',
      });
      chunks.push(...subChunks);
    } else {
      chunks.push({
        content: cleanedText,
        chunkType: 'text',
        metadata: {
          page: pageNum,
          sourceType: 'pdf',
        },
      });
    }
  }

  return chunks;
}

/** Parses a PDF file. */
const MAX_PDF_SIZE = 200 * 1024 * 1024; // 200MB

async function parsePDF(
  payload: ParsePDFPayload,
  abortSignal?: { aborted: boolean }
): Promise<ProcessorResult> {
  const { filePath, options, chunkingConfig } = payload;
  const config = { ...DEFAULT_CHUNKING_CONFIG, ...chunkingConfig };

  try {
    if (abortSignal?.aborted) {
      throw new Error('Parse aborted');
    }

    // ============ Memory Protection ============
    const memCheck = checkMemoryUsage();
    log.debug(
      `Memory usage: ${memCheck.usedMB}MB / ${memCheck.limitMB}MB (${Math.round((memCheck.usedMB / memCheck.limitMB) * 100)}%)`
    );

    if (!memCheck.ok) {
      log.warn(`Memory usage high (${memCheck.usedMB}MB), attempting GC...`);

      const gcSuccess = tryGC();
      if (gcSuccess) {
        log.debug('GC triggered successfully');
      }

      const afterGC = checkMemoryUsage();
      if (!afterGC.ok) {
        log.error(`Memory still high after GC: ${afterGC.usedMB}MB`);
        return {
          success: false,
          chunks: [],
          error: `Worker memory insufficient (${afterGC.usedMB}MB / ${afterGC.limitMB}MB). Please retry later or restart the app.`,
        };
      }
    }

    const fileStats = await fs.stat(filePath);
    if (fileStats.size > MAX_PDF_SIZE) {
      const sizeMB = Math.round(fileStats.size / 1024 / 1024);
      log.error(`PDF file too large: ${sizeMB}MB (limit: ${MAX_PDF_SIZE / 1024 / 1024}MB)`);
      return {
        success: false,
        chunks: [],
        error: `PDF file too large (${sizeMB}MB), max allowed 200MB. Consider compressing or splitting the document.`,
      };
    }

    const dataBuffer = await fs.readFile(filePath);

    if (abortSignal?.aborted) {
      throw new Error('Parse aborted');
    }

    const pdf = await getPdfParse();
    const pageContents: PDFPageContent[] = [];

    const pdfData = await pdf(dataBuffer, {
      pagerender: async (pageData: any) => {
        if (abortSignal?.aborted) {
          throw new Error('Parse aborted');
        }

        // Yield thread to avoid long blocking
        await new Promise((resolve) => setTimeout(resolve, 0));

        const textContent = await pageData.getTextContent();
        const strings = textContent.items.map((item: any) => item.str);
        const pageText = strings.join(' ');

        pageContents.push({
          page: pageContents.length + 1,
          text: pageText,
        });

        return pageText;
      },
    });

    const textContent = pdfData.text || '';
    const cleanedText = cleanPDFText(textContent);

    let chunks: ChunkData[];

    if (pageContents.length > 0 && options?.extractImages !== false) {
      chunks = createPageChunks(pageContents, config, options);
    } else {
      chunks = chunkText(cleanedText, 'text', config);
    }

    const filename = path.basename(filePath);
    const metadata: DocumentMetadata = {
      title: pdfData.info?.Title || path.basename(filename, '.pdf'),
      authors: pdfData.info?.Author ? [pdfData.info.Author] : undefined,
      keywords: pdfData.info?.Keywords?.split(/[,;]/).map((k: string) => k.trim()),
      pageCount: pdfData.numpages,
    };

    const extractedMeta = extractMetadataFromContent(cleanedText);
    Object.assign(metadata, extractedMeta);

    return {
      success: true,
      chunks,
      metadata,
    };
  } catch (error) {
    log.error('Parse error:', error);
    return {
      success: false,
      chunks: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============ Message Handling ============

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

async function handleMessage(message: WorkerMessage): Promise<void> {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'ping':
        sendResponse({ id, success: true, data: 'pong' });
        break;

      case 'parse': {
        const parsePayload = payload as ParsePDFPayload;

        let abortSignal: { aborted: boolean } | undefined;
        if (parsePayload.abortId) {
          abortSignal = { aborted: false };
          abortControllers.set(parsePayload.abortId, abortSignal);
        }

        try {
          const result = await parsePDF(parsePayload, abortSignal);

          if (parsePayload.abortId) {
            abortControllers.delete(parsePayload.abortId);
          }

          sendResponse({
            id,
            success: result.success,
            data: result.success
              ? { chunks: result.chunks, metadata: result.metadata! }
              : undefined,
            error: result.error,
          });
        } catch (error) {
          if (parsePayload.abortId) {
            abortControllers.delete(parsePayload.abortId);
          }
          throw error;
        }
        break;
      }

      case 'abort': {
        const { abortId } = payload as { abortId: string };
        const signal = abortControllers.get(abortId);
        if (signal) {
          signal.aborted = true;
          log.debug('Abort signal set for:', abortId);
        }
        sendResponse({ id, success: true });
        break;
      }

      default:
        sendResponse({ id, success: false, error: `Unknown message type: ${type}` });
    }
  } catch (error) {
    log.error(`Error handling message ${type}:`, error);
    sendResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============ Worker Initialization ============

parentPort?.on('message', handleMessage);

log.info('PDFWorker started');
