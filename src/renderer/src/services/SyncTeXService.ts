/**
 * @file SyncTeXService.ts - Unified SyncTeX Service
 * @description Provides SyncTeX forward/backward sync for both traditional and WASM compilers
 */

import { api } from '../api';
import { createLogger } from './LogService';
import type { StellarLatexEngine } from './StellarLatexEngine';

const logger = createLogger('SyncTeXService');

export interface SyncTeXForwardResult {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface SyncTeXBackwardResult {
  file: string;
  line: number;
  column: number;
}

/**
 * Unified SyncTeX service that handles both traditional (file-based) and WASM (in-memory) SyncTeX
 */
export class SyncTeXService {
  private wasmEngine: StellarLatexEngine | null = null;
  private currentEngineType: 'traditional' | 'wasm' = 'traditional';

  /**
   * Set the current WASM engine for SyncTeX operations
   */
  setWASMEngine(engine: StellarLatexEngine | null): void {
    this.wasmEngine = engine;
    this.currentEngineType = engine ? 'wasm' : 'traditional';
    logger.debug('SyncTeX engine type changed', { type: this.currentEngineType });
  }

  /**
   * Forward sync: source location → PDF position
   */
  async forward(
    sourcePath: string,
    line: number,
    column: number,
    synctexPath?: string | null
  ): Promise<SyncTeXForwardResult | null> {
    if (this.currentEngineType === 'wasm' && this.wasmEngine) {
      return this.forwardWASM(sourcePath, line, column);
    }
    return this.forwardTraditional(sourcePath, line, column, synctexPath);
  }

  /**
   * Backward sync: PDF position → source location
   */
  async backward(
    pageNum: number,
    x: number,
    y: number,
    synctexPath?: string | null
  ): Promise<SyncTeXBackwardResult | null> {
    if (this.currentEngineType === 'wasm' && this.wasmEngine) {
      return this.backwardWASM(pageNum, x, y);
    }
    return this.backwardTraditional(pageNum, x, y, synctexPath);
  }

  // ====== WASM Implementation ======

  private async forwardWASM(
    sourcePath: string,
    line: number,
    column: number
  ): Promise<SyncTeXForwardResult | null> {
    if (!this.wasmEngine) return null;

    try {
      const wasmSourcePath =
        this.wasmEngine.resolveWasmPath(sourcePath) ??
        sourcePath.split(/[/\\]/).pop() ??
        this.wasmEngine.getMainFile();
      const result = await this.wasmEngine.synctexView(
        this.wasmEngine.getOutputPdfPath(),
        wasmSourcePath,
        line,
        column
      );

      if (!result) return null;

      return {
        page: result.page,
        x: result.x,
        y: result.y,
        width: result.W,
        height: result.H,
      };
    } catch (error) {
      logger.error('WASM SyncTeX forward failed', { error });
      return null;
    }
  }

  private async backwardWASM(
    pageNum: number,
    x: number,
    y: number
  ): Promise<SyncTeXBackwardResult | null> {
    if (!this.wasmEngine) return null;

    try {
      const result = await this.wasmEngine.synctexEdit(
        this.wasmEngine.getOutputPdfPath(),
        pageNum,
        x,
        y
      );

      if (!result) return null;

      return {
        file: this.wasmEngine.resolveHostPath(result.file) ?? result.file,
        line: result.line,
        column: result.column,
      };
    } catch (error) {
      logger.error('WASM SyncTeX backward failed', { error });
      return null;
    }
  }

  // ====== Traditional Implementation ======

  private async forwardTraditional(
    sourcePath: string,
    line: number,
    column: number,
    synctexPath?: string | null
  ): Promise<SyncTeXForwardResult | null> {
    if (!synctexPath) return null;

    try {
      const result = await api.synctex.forward(sourcePath, line, column, synctexPath);
      return result || null;
    } catch (error) {
      logger.error('Traditional SyncTeX forward failed', { error });
      return null;
    }
  }

  private async backwardTraditional(
    pageNum: number,
    x: number,
    y: number,
    synctexPath?: string | null
  ): Promise<SyncTeXBackwardResult | null> {
    if (!synctexPath) return null;

    try {
      const result = await api.synctex.backward(synctexPath, pageNum, x, y);
      return result || null;
    } catch (error) {
      logger.error('Traditional SyncTeX backward failed', { error });
      return null;
    }
  }
}

// Singleton instance
let syncTeXServiceInstance: SyncTeXService | null = null;

export function getSyncTeXService(): SyncTeXService {
  if (!syncTeXServiceInstance) {
    syncTeXServiceInstance = new SyncTeXService();
  }
  return syncTeXServiceInstance;
}
