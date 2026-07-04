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

/**
 * CMap directory required for CJK glyph rendering. The `.bcmap` files are copied
 * from `pdfjs-dist/cmaps` into the renderer's `public/cmaps/` by
 * `scripts/copy-public-assets.js`, so they're served at the renderer root.
 * Resolve against the document URL (dev http:// and prod file:// both work),
 * mirroring how BusyTexEngine loads its worker — NOT against `import.meta.url`,
 * which points at the bundled JS chunk where no cmaps exist (that produced
 * "unexpected EOF in bcmap" and blank CJK).
 */
export const CMAP_URL = new URL('./cmaps/', window.location.href).toString();

export { pdfjsLib };
