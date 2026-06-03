/**
 * @file pdfjsRuntime.ts —— pdf.js 运行时的单一配置点(workerSrc + CMap URL)。
 *   PdfPreviewPane 与 CiteShotService 共用,避免两处各自配 worker 路径产生漂移。
 *
 * 必须用 `legacy/` build:它带 core-js polyfill(含 Promise.try),Electron 30
 * (Chromium 124)缺 Promise.try,modern build 会运行时崩。见 feedback_electron_dep_pinning。
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/** CJK 字符渲染所需的 CMap 目录(运行时解析)。 */
export const CMAP_URL = new URL(/* @vite-ignore */ 'pdfjs-dist/cmaps/', import.meta.url).toString();

export { pdfjsLib };
