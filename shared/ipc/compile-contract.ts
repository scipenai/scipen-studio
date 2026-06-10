/**
 * @file Compilation IPC Contract
 * @description Compilation types and channel contract (LaTeX, Typst, SyncTeX)
 * @depends ipc/channels, ipc/types
 */

import { IpcChannel } from './channels';
import type {
  LaTeXCompileOptions,
  LaTeXCompileResult,
  SyncTeXForwardResult,
  SyncTeXBackwardResult,
} from './types';

// ====== Compilation Types ======

export interface TypstCompileOptions {
  engine?: 'typst' | 'tinymist' | 'wasm-typst';
  mainFile?: string;
  projectPath?: string;
}

/** Availability + version for a single Typst-family engine. */
export interface TypstEngineCapability {
  available: boolean;
  /** Semver string when available, null otherwise. */
  version: string | null;
}

/**
 * Combined capability snapshot. `cli.*` is probed by spawning each binary
 * with `--version`; `wasm.available` is true when the bundled WASM assets
 * (manifest + compiler) are present on disk. Order is meaningful — the
 * UI uses it to render dropdown options in a stable order.
 */
export interface TypstCapabilities {
  cli: {
    tinymist: TypstEngineCapability;
    typst: TypstEngineCapability;
  };
  wasm: TypstEngineCapability;
}

export interface TypstCompileResult {
  success: boolean;
  pdfPath?: string;
  pdfBuffer?: Uint8Array;
  /** @deprecated Use pdfBuffer instead */
  pdfData?: string;
  errors: string[];
  warnings?: string[];
  log?: string;
}

export interface TypstAvailability {
  tinymist: { available: boolean; version: string | null };
  typst: { available: boolean; version: string | null };
}

export type CompileCancelType = 'latex' | 'typst';

export interface CompileCancelResult {
  success: boolean;
  cancelled: number;
}

/**
 * Result of `Compile_WriteWasmArtifacts`.
 *
 * WASM compile output (PDF + `.synctex.gz` as raw bytes) is persisted into
 * a fresh `os.tmpdir()` subdir so the main-process `synctex` CLI can read
 * them. The renderer only ever consumes the two file paths.
 */
export interface CompileWasmArtifactsResult {
  pdfPath: string;
  synctexPath: string;
}

// ====== Channel Contract ======

export interface IPCCompileContract {
  [IpcChannel.Compile_LaTeX]: {
    args: [content: string, options?: LaTeXCompileOptions];
    result: LaTeXCompileResult;
  };
  [IpcChannel.Compile_Typst]: {
    args: [content: string, options?: TypstCompileOptions];
    result: TypstCompileResult;
  };
  [IpcChannel.Compile_Cancel]: {
    args: [type?: CompileCancelType];
    result: CompileCancelResult;
  };
  [IpcChannel.Compile_GetStatus]: {
    args: [];
    result: {
      latex: { isCompiling: boolean; queueLength: number; currentTaskId: string | null };
      typst: { isCompiling: boolean };
    };
  };
  [IpcChannel.Compile_WriteWasmArtifacts]: {
    args: [pdfBuffer: Uint8Array, synctexBuffer: Uint8Array, baseName?: string];
    result: CompileWasmArtifactsResult;
  };
  [IpcChannel.Typst_Available]: {
    args: [];
    result: TypstAvailability;
  };
  [IpcChannel.Typst_GetCapabilities]: {
    args: [];
    result: TypstCapabilities;
  };
  [IpcChannel.SyncTeX_Forward]: {
    args: [
      texFile: string,
      line: number,
      column: number,
      pdfFile: string,
      projectRoot?: string,
    ];
    result: SyncTeXForwardResult | null;
  };
  [IpcChannel.SyncTeX_Backward]: {
    args: [pdfFile: string, page: number, x: number, y: number, projectRoot?: string];
    result: SyncTeXBackwardResult | null;
  };
}
