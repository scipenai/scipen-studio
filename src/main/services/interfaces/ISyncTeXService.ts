/**
 * @file ISyncTeXService - SyncTeX service contract
 * @description Bidirectional sync between LaTeX source and PDF
 * @depends SyncTeXService
 */

// ====== Type Definitions ======

/**
 * Forward sync result (source -> PDF).
 */
export interface ForwardSyncResult {
  /** PDF page number (1-based). */
  page: number;
  /** Horizontal position (PDF points). */
  x: number;
  /** Vertical position (PDF points). */
  y: number;
  /** Highlight width. */
  width: number;
  /** Highlight height. */
  height: number;
}

/**
 * Inverse sync result (PDF -> source).
 */
export interface InverseSyncResult {
  /** Source file path. */
  file: string;
  /** Line number (1-based). */
  line: number;
  /** Column number (0-based). */
  column: number;
}

// ====== Interface Definition ======

/**
 * SyncTeX service interface.
 */
export interface ISyncTeXService {
  /**
   * Forward sync: source location -> PDF position.
   * @param synctexFile Path to .synctex(.gz) file (or PDF path; inferred)
   * @param sourceFile Absolute source file path
   * @param line Line number (1-based)
   * @param column Column number (0-based)
   * @returns PDF position or null on failure
   */
  forwardSync(
    synctexFile: string,
    sourceFile: string,
    line: number,
    column?: number
  ): Promise<ForwardSyncResult | null>;

  /**
   * Inverse sync: PDF position -> source location.
   * @param pdfFile PDF file path
   * @param page Page number (1-based)
   * @param x Horizontal position (PDF points)
   * @param y Vertical position (PDF points)
   * @returns Source position or null on failure
   */
  inverseSync(
    pdfFile: string,
    page: number,
    x: number,
    y: number
  ): Promise<InverseSyncResult | null>;
}
