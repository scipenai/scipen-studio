/**
 * @file pdf-parse.d.ts - pdf-parse Module Type Declaration
 * @description Provides TypeScript type definitions for pdf-parse library
 * @see https://www.npmjs.com/package/pdf-parse
 */

declare module 'pdf-parse' {
  interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    IsXFAPresent?: boolean;
    Title?: string;
    Author?: string;
    Subject?: string;
    Keywords?: string;
    Creator?: string;
    Producer?: string;
    CreationDate?: string;
    ModDate?: string;
    [key: string]: unknown;
  }

  interface PDFMetadata {
    _metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface PDFData {
    /** Total number of pages */
    numpages: number;
    /** Number of rendered pages */
    numrender: number;
    /** PDF info object */
    info: PDFInfo;
    /** PDF metadata */
    metadata: PDFMetadata | null;
    /** PDF version */
    version: string;
    /** Extracted text content */
    text: string;
  }

  interface PDFParseOptions {
    /** Page render callback */
    pagerender?: (pageData: { pageIndex: number; getTextContent: () => Promise<unknown> }) => Promise<string>;
    /** Maximum number of pages to parse (0 = all) */
    max?: number;
    /** PDF.js version */
    version?: string;
  }

  function pdfParse(dataBuffer: Buffer, options?: PDFParseOptions): Promise<PDFData>;

  export = pdfParse;
}
