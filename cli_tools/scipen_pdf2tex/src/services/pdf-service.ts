import * as fs from 'fs/promises';
import { createCanvas, Path2D, ImageData, DOMMatrix, DOMPoint } from '@napi-rs/canvas';
import type { PDFPageImage } from '../types';
import { Logger } from '../utils/logger';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsLibPromise: Promise<PdfjsModule> | null = null;

async function getPdfjsLib(): Promise<PdfjsModule> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLibPromise;
}

// Set global objects for pdfjs to use
(global as any).Path2D = Path2D;
(global as any).ImageData = ImageData;
(global as any).DOMMatrix = DOMMatrix;
(global as any).DOMPoint = DOMPoint;

// Suppress pdfjs warning output
const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  const msg = args[0]?.toString() || '';
  // Filter out font-related warnings
  if (
    msg.includes('getPathGenerator') ||
    msg.includes("Requesting object that isn't resolved") ||
    msg.includes('Warning: TT')
  ) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

export class PDFService {
  async extractPages(pdfPath: string, dpi = 300): Promise<PDFPageImage[]> {
    Logger.info(`Extracting PDF pages: ${pdfPath}`);

    const data = await fs.readFile(pdfPath);
    const pdfjsLib = await getPdfjsLib();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(data),
      useSystemFonts: true,
      standardFontDataUrl: undefined, // Do not use standard font data
      disableFontFace: true, // Disable font face, use system font rendering
      useWorkerFetch: false,
      isEvalSupported: false,
      disableWorker: true,
      verbosity: 0, // Minimum log level
    } as any);

    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;

    Logger.info(`PDF has ${numPages} pages`);

    const pages: PDFPageImage[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      Logger.info(`Processing page ${pageNum}/${numPages}`);

      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: dpi / 72 });

      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      // @ts-ignore - Node.js canvas 兼容性问题
      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;

      const buffer = canvas.toBuffer('image/png');

      pages.push({
        pageNumber: pageNum,
        imageBuffer: buffer,
        width: viewport.width,
        height: viewport.height,
      });
    }

    Logger.success(`Successfully extracted ${numPages} pages`);
    return pages;
  }

  async readPDFAsBase64(pdfPath: string): Promise<string> {
    const buffer = await fs.readFile(pdfPath);
    return buffer.toString('base64');
  }
}
