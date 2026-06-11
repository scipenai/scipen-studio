/**
 * @file pdfjsRuntime.ts — single configuration point for pdf.js runtime (workerSrc + CMap URL).
 *   Shared by PdfPreviewPane and CiteShotService; avoids drift from two separate worker paths.
 *
 * Must use the `legacy/` build: it ships with core-js polyfills (incl. Promise.try). Electron 30
 * (Chromium 124) lacks Promise.try, and the modern build crashes at runtime. See feedback_electron_dep_pinning.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/** CMap directory required for CJK glyph rendering (resolved at runtime). */
export const CMAP_URL = new URL(/* @vite-ignore */ 'pdfjs-dist/cmaps/', import.meta.url).toString();

export { pdfjsLib };
