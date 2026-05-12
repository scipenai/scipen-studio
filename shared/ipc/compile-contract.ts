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
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
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
  [IpcChannel.Typst_Available]: {
    args: [];
    result: TypstAvailability;
  };
  [IpcChannel.SyncTeX_Forward]: {
    args: [texFile: string, line: number, column: number, pdfFile: string];
    result: SyncTeXForwardResult | null;
  };
  [IpcChannel.SyncTeX_Backward]: {
    args: [pdfFile: string, page: number, x: number, y: number];
    result: SyncTeXBackwardResult | null;
  };
}
