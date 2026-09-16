/**
 * @file compilePhaseParser - BusyTeX worker print line → compile phase signal
 * @description The BusyTeX worker streams its internal progress as plain
 *              `{print: msg}` messages: every pipeline step prints a
 *              `$ busytex <cmd>` line, emscripten prints `Preparing... (n/m)`
 *              while data packages load, and the pipeline lists the TeX
 *              packages it resolved. This module turns those lines into
 *              structured {@link CompileProgressPayload} events for the UI.
 *
 *              Pure and stateful-by-argument (the caller owns a mutable
 *              state object per compile) so it is trivially unit-testable
 *              and free of service imports. Semantics live here; transport
 *              lives in BusyTexEngine; orchestration lives in
 *              WASMCompilerProvider — each layer independently replaceable.
 *
 * @depends shared/ipc/compile-contract (payload shape)
 */

import type { CompileProgressPayload } from '../../../shared/ipc/compile-contract';

/** Mutable parse state — one instance per compile, owned by the provider. */
export interface BusyTexPhaseState {
  /** 1-based counter over typesetting engine commands (pdflatex/xelatex/luahblatex). */
  passIndex: number;
}

export function createBusyTexPhaseState(): BusyTexPhaseState {
  return { passIndex: 0 };
}

/** Programs that count as a typesetting pass (everything else is postprocessing). */
const TEX_ENGINE_PROGRAMS = new Set(['pdflatex', 'xelatex', 'lualatex', 'luahblatex']);

/**
 * Parse one worker print line. Returns null for lines that carry no
 * phase-worthy signal (kpathsea chatter, exit codes, blank lines) — the
 * caller must not emit for null.
 */
export function parseBusyTexPrintLine(
  line: string,
  state: BusyTexPhaseState
): CompileProgressPayload | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // "Preparing... (3/7)" — emscripten monitorRunDependencies during engine
  // init / data-package load. Completed/total, not remaining/total.
  const preparing = /^Preparing\.\.\.\s*\((\d+)\/(\d+)\)$/.exec(trimmed);
  if (preparing) {
    const done = Number(preparing[1]);
    const total = Math.max(1, Number(preparing[2]));
    return {
      engine: 'latex',
      stage: 'engine-load',
      message: trimmed,
      percent: Math.min(100, Math.round((done / total) * 100)),
    };
  }

  // "$ busytex <program> [args...]" — one pipeline command. The program name
  // decides whether this is a typesetting pass or postprocessing.
  if (trimmed.startsWith('$ busytex ')) {
    const program = trimmed.slice('$ busytex '.length).split(/\s+/)[0] ?? '';
    if (TEX_ENGINE_PROGRAMS.has(program)) {
      state.passIndex += 1;
      return {
        engine: 'latex',
        stage: 'pass',
        message: `Running ${program} (pass ${state.passIndex})`,
        passIndex: state.passIndex,
      };
    }
    return {
      engine: 'latex',
      stage: 'postprocess',
      message: `Running ${program}`,
    };
  }

  // "New compilation started: [main.tex]" — top-of-compile marker.
  if (trimmed.startsWith('New compilation started:')) {
    return {
      engine: 'latex',
      stage: 'staging',
      message: trimmed.replace(/^New compilation started:\s*/, 'Compiling '),
    };
  }

  // "TeX packages: [amsmath, ctex]" — package resolution result. Only the
  // first (all used packages) line is worth surfacing; the sibling
  // local/unresolved variants are diagnostics, not progress.
  const packages = /^TeX packages:\s*\[(.*)\]$/.exec(trimmed);
  if (packages) {
    return {
      engine: 'latex',
      stage: 'staging',
      message: packages[1].trim() ? `TeX packages: ${packages[1].trim()}` : 'TeX packages: none',
    };
  }

  return null;
}
