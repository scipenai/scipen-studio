/**
 * @file IPC Types - IPC Communication Type Definitions
 * @description Defines data structures for communication between main and renderer processes
 */

import type { LaTeXEngine } from '../../renderer/src/types/app';

// ====== LaTeX Compilation ======

/** LaTeX compilation options */
export interface CompileLatexOptions {
  /** Compilation engine */
  engine?: LaTeXEngine;
  /** Enable shell-escape */
  shellEscape?: boolean;
  /** Enable SyncTeX */
  synctex?: boolean;
  /** Output directory */
  outputDirectory?: string;
  /** Stop on first error */
  stopOnFirstError?: boolean;
  /** Draft mode */
  draft?: boolean;
  /** Main file path (for SyncTeX) */
  mainFile?: string;
}
