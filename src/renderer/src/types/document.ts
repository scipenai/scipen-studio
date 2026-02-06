/**
 * @file document.ts - Document type definitions
 * @description Defines document media types, processing states, and metadata structures
 */

/** Document media type */
export type DocumentMediaType = 'text' | 'pdf' | 'image' | 'audio';

export type DocumentProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DocumentMetadata {
  title?: string;
  abstract?: string;
  authors?: string[];
  keywords?: string[];
}

export interface DocumentInfo {
  id: string;
  filename: string;
  mediaType: DocumentMediaType | string;
  fileSize: number;
  processStatus: DocumentProcessStatus | string;
  createdAt: number;
  metadata?: DocumentMetadata;
}

export interface FileConflict {
  path: string;
  type: 'change' | 'unlink';
  hasUnsavedChanges: boolean;
}

export interface PolishRequest {
  originalText: string;
  polishedText: string | null;
  isPolishing: boolean;
  selectionRange: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  filePath: string | null;
}

export interface PDFHighlight {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface SelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
