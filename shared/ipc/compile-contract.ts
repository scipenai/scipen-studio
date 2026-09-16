/**
 * @file Compilation IPC Contract
 * @description Compilation types and channel contract (LaTeX, Typst)
 * @depends ipc/channels, ipc/types
 */

import { IpcChannel } from './channels';
import type { LaTeXCompileOptions, LaTeXCompileResult } from './types';

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

/** Availability + version for a single LaTeX-family engine. */
export interface LaTeXEngineCapability {
  available: boolean;
  /** Version/banner string when available, null otherwise. */
  version: string | null;
}

/**
 * Combined LaTeX capability snapshot. `cli.*` is probed by spawning each
 * binary with `--version`; `wasm.*` is true when the bundled BusyTeX assets
 * are present on disk.
 */
export interface LaTeXCapabilities {
  cli: {
    pdflatex: LaTeXEngineCapability;
    xelatex: LaTeXEngineCapability;
    lualatex: LaTeXEngineCapability;
    tectonic: LaTeXEngineCapability;
  };
  wasm: {
    pdftex: LaTeXEngineCapability;
    xetex: LaTeXEngineCapability;
    lualatex: LaTeXEngineCapability;
  };
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
 * Result of probing a TeX Live remote endpoint. Discriminated and total —
 * the handler catches everything, so the renderer never needs a try/catch
 * (mirrors `ZoteroWebApiPingResultDTO`).
 */
export interface TexliveEndpointProbeResult {
  ok: boolean;
  /** Round-trip time in milliseconds; present only when `ok`. */
  latencyMs?: number;
  /** HTTP status observed, when the request completed at all. */
  status?: number;
  /** Human-readable cause when `ok` is false. */
  error?: string;
}

/**
 * Staged compile request for the BusyTeX engine process. The renderer does
 * the staging (it owns the unsaved editor buffer); the engine process does
 * everything else, including writing the artifacts to disk.
 */
export interface BusyTeXCompileRequestDTO {
  /**
   * Staged files handed to the engine's virtual FS. `encoding` defaults to
   * utf8 (TeX sources); `base64` carries BINARY files (figures) — the child
   * decodes to bytes before writing them into the VFS, so xdvipdfmx embeds
   * real JPEGs/PNGs instead of failing on missing files.
   */
  files: Array<{ path: string; contents: string; encoding?: 'utf8' | 'base64' }>;
  /** Staged name of the main file (project-relative). */
  mainFile: string;
  /** BusyTeX driver, e.g. `xetex_bibtex8_dvipdfmx`. */
  driver: string;
  /** TeX Live remote endpoint for on-demand packages (may be empty). */
  endpoint: string;
  /** Directory the PDF + `.synctex.gz` are written to. */
  outputDir: string;
  /** Artifact base name (main file without extension). */
  baseName: string;
}

/**
 * Total result for one BusyTeX compile. `cancelled` marks the stop button /
 * engine teardown — a neutral outcome, not a failure.
 */
export interface BusyTeXCompileResultDTO {
  success: boolean;
  cancelled?: boolean;
  exitCode?: number;
  pdfPath?: string;
  synctexPath?: string;
  log: string;
  errors: string[];
}

/**
 * Live compile progress, pushed main → renderer over `Compile_Progress`
 * (CLI engines) and emitted renderer-internally for the WASM engines via
 * `CompilerOptions.onPhase` (same shape, one UI consumer). `stage` is a
 * stable machine identifier for the UI to localize; `message` is the raw
 * human-readable detail (engine command line, package list, worker step) —
 * intentionally English-technical, consistent with compile log entries.
 */
export interface CompileProgressPayload {
  /** Engine family the progress belongs to. */
  engine: 'latex' | 'typst';
  /**
   * Stable stage identifier: `engine-load` (WASM engine boot / data-package
   * fetch), `staging` (project files → worker FS), `pass` (one typesetting
   * command), `postprocess` (bibtex / makeindex / xdvipdfmx), `writing`
   * (artifacts → disk), `cli` (unstructured worker step from the CLI path).
   */
  stage: 'engine-load' | 'staging' | 'pass' | 'postprocess' | 'writing' | 'cli';
  /** Raw detail line, safe to show in the log panel. */
  message: string;
  /** 0–100 when the stage has a measurable fraction, absent otherwise. */
  percent?: number;
  /** 1-based typesetting pass index for `stage: 'pass'`. */
  passIndex?: number;
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
  [IpcChannel.Compile_TestTexliveEndpoint]: {
    args: [endpoint: string];
    result: TexliveEndpointProbeResult;
  };
  [IpcChannel.Compile_BusyTeX_Prepare]: {
    args: [];
    result: { ok: boolean };
  };
  [IpcChannel.Compile_BusyTeX_Compile]: {
    args: [request: BusyTeXCompileRequestDTO];
    result: BusyTeXCompileResultDTO;
  };
  [IpcChannel.Compile_BusyTeX_Cancel]: {
    args: [];
    result: { ok: boolean };
  };
  [IpcChannel.LaTeX_GetCapabilities]: {
    args: [];
    result: LaTeXCapabilities;
  };
  [IpcChannel.Typst_Available]: {
    args: [];
    result: TypstAvailability;
  };
  [IpcChannel.Typst_GetCapabilities]: {
    args: [];
    result: TypstCapabilities;
  };
}
