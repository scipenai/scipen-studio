/**
 * @file StellarLatexEngine.ts - StellarLatex WASM Engine Wrapper
 * @description Wraps the StellarLatex Web Worker message protocol into a Promise-based API.
 *              Engines run entirely in the renderer process via Web Workers.
 * @depends StellarLatex WASM artifacts in public/wasm/
 */

import { createLogger } from './LogService';

const logger = createLogger('StellarLatexEngine');

type EngineType = 'pdftex' | 'xetex';

interface WorkerResponse {
  result: 'ok' | 'failed';
  status?: number;
  log?: string;
  pdf?: ArrayBuffer;
  synctex?: ArrayBuffer;
  cmd?: string;
  // synctex_view fields
  page?: number;
  x?: number;
  y?: number;
  h?: number;
  v?: number;
  W?: number;
  H?: number;
  // synctex_edit fields
  file?: string;
  line?: number;
  column?: number;
  // engine log
  level?: string;
  message?: string;
}

export interface CompileOutput {
  success: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  status: number;
}

export interface SyncTeXViewResult {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface SyncTeXEditResult {
  file: string;
  line: number;
  column: number;
}

type LogCallback = (level: string, message: string) => void;

/**
 * Wraps a StellarLatex WASM Web Worker.
 *
 * Message protocol (StellarLatex/pdftex.wasm/pre.js):
 *   Commands: compilelatex, compileformat, settexliveurl, mkdir, writefile,
 *             setmainfile, grace, flushwork, flushbuild, synctex_view, synctex_edit
 *   Responses: {result, status?, log?, pdf?, synctex?, cmd}
 */
export class StellarLatexEngine {
  private worker: Worker | null = null;
  private _ready = false;
  private onLog: LogCallback | null = null;
  private mainFile = 'main.tex';
  private hostToWasmPath = new Map<string, string>();
  private wasmToHostPath = new Map<string, string>();

  readonly engineType: EngineType;

  constructor(engineType: EngineType) {
    this.engineType = engineType;
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Creates the Web Worker and waits for the Emscripten module to initialize.
   * The worker sends {result:'ok'} in Module['postRun'] when ready.
   */
  async loadEngine(): Promise<void> {
    if (this._ready && this.worker) return;

    const jsFile = this.engineType === 'pdftex' ? 'stellarlatexpdftex.js' : 'stellarlatexxetex.js';

    // Build Worker URL: use relative path for file:// protocol, absolute URL for http://
    const workerUrl =
      window.location.protocol === 'file:'
        ? `./wasm/${jsFile}`
        : new URL(`/wasm/${jsFile}`, window.location.origin).href;

    logger.info(`Loading WASM engine: ${this.engineType}`, { url: workerUrl });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`WASM engine load timeout (${this.engineType})`));
      }, 60000);

      try {
        this.worker = new Worker(workerUrl);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to create WASM worker: ${err}`));
        return;
      }

      // The first message from the worker is the initialization signal
      const initHandler = (ev: MessageEvent<WorkerResponse>) => {
        const data = ev.data;

        // Module['postRun'] sends {result: 'ok'} with no cmd
        if (data.result === 'ok' && !data.cmd) {
          clearTimeout(timeout);
          this._ready = true;
          this.worker!.removeEventListener('message', initHandler);
          // Install the permanent message handler
          this.worker!.addEventListener('message', this.handleMessage.bind(this));
          logger.info(`WASM engine ready: ${this.engineType}`);
          resolve();
        }
      };

      this.worker.addEventListener('message', initHandler);
      this.worker.addEventListener('error', (err: ErrorEvent) => {
        clearTimeout(timeout);
        const errorDetails = {
          message: err.message,
          filename: err.filename,
          lineno: err.lineno,
          colno: err.colno,
          error: err.error?.toString(),
        };
        logger.error('WASM worker error', { ...errorDetails, url: workerUrl });
        reject(
          new Error(
            `WASM worker failed to load: ${err.message || 'Unknown error'} at ${err.filename || workerUrl}`
          )
        );
      });
    });
  }

  /**
   * Set a callback for compilation log messages.
   */
  setLogCallback(callback: LogCallback | null): void {
    this.onLog = callback;
  }

  /**
   * Write a file to the WASM virtual filesystem (/work/ directory).
   */
  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    this.ensureReady();
    return this.sendCommand(
      {
        cmd: 'writefile',
        url: filePath,
        src: content,
      },
      'writefile'
    );
  }

  /**
   * Create a directory in the WASM virtual filesystem.
   */
  async mkdir(dirPath: string): Promise<void> {
    this.ensureReady();
    return this.sendCommand(
      {
        cmd: 'mkdir',
        url: dirPath,
      },
      'mkdir'
    );
  }

  /**
   * Set the main .tex file for compilation.
   */
  setMainFile(filename: string): void {
    this.ensureReady();
    this.mainFile = filename;
    this.worker!.postMessage({ cmd: 'setmainfile', url: filename });
  }

  getMainFile(): string {
    return this.mainFile;
  }

  getOutputPdfPath(): string {
    const fileName = this.mainFile.split(/[/\\]/).pop() || 'main.tex';
    const stem = fileName.includes('.')
      ? fileName.substring(0, fileName.lastIndexOf('.'))
      : fileName;
    return `/output/${stem}.pdf`;
  }

  registerPathMapping(hostPath: string, wasmRelativePath: string): void {
    const normalizedHostPath = hostPath.replace(/\\/g, '/');
    const normalizedWasmPath = wasmRelativePath.replace(/\\/g, '/');

    this.hostToWasmPath.set(normalizedHostPath, normalizedWasmPath);
    this.wasmToHostPath.set(normalizedWasmPath, normalizedHostPath);
    this.wasmToHostPath.set(`/work/${normalizedWasmPath}`, normalizedHostPath);
  }

  resolveWasmPath(hostPath: string): string | null {
    const normalizedHostPath = hostPath.replace(/\\/g, '/');
    return this.hostToWasmPath.get(normalizedHostPath) ?? null;
  }

  resolveHostPath(wasmPath: string): string | null {
    const normalizedWasmPath = wasmPath.replace(/\\/g, '/');
    return this.wasmToHostPath.get(normalizedWasmPath) ?? null;
  }

  clearPathMappings(): void {
    this.hostToWasmPath.clear();
    this.wasmToHostPath.clear();
  }

  /**
   * Set the TeX Live endpoint URL for on-demand package fetching.
   */
  setTexliveEndpoint(url: string): void {
    this.ensureReady();
    this.worker!.postMessage({ cmd: 'settexliveurl', url });
  }

  /**
   * Compile the LaTeX document. Returns PDF buffer, log, and synctex data.
   */
  async compile(): Promise<CompileOutput> {
    this.ensureReady();

    return new Promise<CompileOutput>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WASM compilation timeout (5 minutes)'));
      }, 300000);

      const handler = (ev: MessageEvent<WorkerResponse>) => {
        const data = ev.data;

        // Compilation log messages during compilation
        if (data.cmd === 'engine_compiling_log') {
          this.onLog?.(data.level || 'info', data.message || '');
          return;
        }

        // Compilation result
        if (data.cmd === 'compile') {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);

          const success = data.result === 'ok' && data.status === 0;
          const output: CompileOutput = {
            success,
            log: data.log || '',
            status: data.status ?? -1,
          };

          if (data.pdf) {
            output.pdf = new Uint8Array(data.pdf);
          }
          if (data.synctex) {
            output.synctex = new Uint8Array(data.synctex);
          }

          resolve(output);
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage({ cmd: 'compilelatex' });
    });
  }

  /**
   * SyncTeX forward search: source location → PDF position.
   */
  async synctexView(
    pdfPath: string,
    texPath: string,
    line: number,
    column: number
  ): Promise<SyncTeXViewResult | null> {
    this.ensureReady();

    return new Promise<SyncTeXViewResult | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10000);

      const handler = (ev: MessageEvent<WorkerResponse>) => {
        const data = ev.data;
        if (data.cmd === 'synctex_view') {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);

          if (data.result === 'ok' && data.page !== undefined) {
            resolve({
              page: data.page,
              x: data.x ?? 0,
              y: data.y ?? 0,
              h: data.h ?? 0,
              v: data.v ?? 0,
              W: data.W ?? 0,
              H: data.H ?? 0,
            });
          } else {
            resolve(null);
          }
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage({
        cmd: 'synctex_view',
        pdfPath,
        texPath,
        line,
        column,
      });
    });
  }

  /**
   * SyncTeX reverse search: PDF position → source location.
   */
  async synctexEdit(
    pdfPath: string,
    page: number,
    x: number,
    y: number
  ): Promise<SyncTeXEditResult | null> {
    this.ensureReady();

    return new Promise<SyncTeXEditResult | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10000);

      const handler = (ev: MessageEvent<WorkerResponse>) => {
        const data = ev.data;
        if (data.cmd === 'synctex_edit') {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);

          if (data.result === 'ok' && data.file) {
            resolve({
              file: data.file,
              line: data.line ?? 0,
              column: data.column ?? 0,
            });
          } else {
            resolve(null);
          }
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage({
        cmd: 'synctex_edit',
        pdfPath,
        page,
        x,
        y,
      });
    });
  }

  /**
   * Clear the /work directory (user files).
   */
  flushWorkDir(): void {
    this.ensureReady();
    this.clearPathMappings();
    this.worker!.postMessage({ cmd: 'flushwork' });
  }

  /**
   * Clear the /output and /tmp directories (build artifacts).
   */
  flushBuild(): void {
    this.ensureReady();
    this.worker!.postMessage({ cmd: 'flushbuild' });
  }

  /**
   * Terminate the worker immediately.
   */
  close(): void {
    if (this.worker) {
      this.worker.terminate(); // Force-terminate the worker thread
      this.worker = null;
      this._ready = false;
    }
  }

  // ====== Internal ======

  private handleMessage(ev: MessageEvent<WorkerResponse>): void {
    const data = ev.data;
    // Handle engine log messages that come outside of compile context
    if (data.cmd === 'engine_compiling_log') {
      this.onLog?.(data.level || 'info', data.message || '');
    }
  }

  private ensureReady(): void {
    if (!this._ready || !this.worker) {
      throw new Error(`WASM engine not ready (${this.engineType}). Call loadEngine() first.`);
    }
  }

  /**
   * Send a command and wait for a specific response cmd.
   */
  private sendCommand(message: Record<string, unknown>, expectedCmd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`WASM command timeout: ${expectedCmd}`));
      }, 30000);

      const handler = (ev: MessageEvent<WorkerResponse>) => {
        if (ev.data.cmd === expectedCmd) {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);

          if (ev.data.result === 'ok') {
            resolve();
          } else {
            reject(new Error(`WASM command failed: ${expectedCmd}`));
          }
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage(message);
    });
  }
}
