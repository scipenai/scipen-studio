/**
 * @file SyncTeXService.ts - Unified SyncTeX Service (renderer-side)
 * @description Thin facade over `api.synctex.forward/backward`. Both CLI
 *              and BusyTeX WASM compiles produce a `.synctex.gz` on disk
 *              (the WASM path persists its buffer via WASMCompilerProvider),
 *              so SyncTeX always resolves through the main-process `synctex`
 *              CLI — there is no engine-specific query path.
 */

import { api } from '../api';
import { createLogger } from './LogService';

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

export class SyncTeXService {
  /**
   * Forward sync: source location → PDF position.
   * @param projectRoot Required only for BusyTeX WASM compiles (the
   *   `.synctex.gz` records MEMFS-absolute paths under
   *   `/home/web_user/project_dir/`; main rebases them against this
   *   root). Omit for CLI compiles which record host-absolute paths.
   */
  async forward(
    sourcePath: string,
    line: number,
    column: number,
    synctexPath?: string | null,
    projectRoot?: string
  ): Promise<SyncTeXForwardResult | null> {
    if (!synctexPath) return null;

    try {
      const result = await api.synctex.forward(sourcePath, line, column, synctexPath, projectRoot);
      return result || null;
    } catch (error) {
      logger.error('SyncTeX forward failed', { error });
      return null;
    }
  }

  /**
   * Backward sync: PDF position → source location.
   * @param projectRoot See `forward`.
   */
  async backward(
    pageNum: number,
    x: number,
    y: number,
    synctexPath?: string | null,
    projectRoot?: string
  ): Promise<SyncTeXBackwardResult | null> {
    if (!synctexPath) return null;

    try {
      const result = await api.synctex.backward(synctexPath, pageNum, x, y, projectRoot);
      return result || null;
    } catch (error) {
      logger.error('SyncTeX backward failed', { error });
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
