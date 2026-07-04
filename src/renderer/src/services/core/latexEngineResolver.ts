/**
 * @file latexEngineResolver.ts - Resolve the `auto` LaTeX engine
 * @description The `auto` engine (default) means "prefer a locally-installed
 *              LaTeX, else fall back to the WASM engine". This module probes
 *              local capability once (cached) and resolves `auto` to a concrete
 *              engine at compile time, so the provider routing never sees
 *              `auto`.
 */

import type { LaTeXCapabilities } from '../../../../../shared/ipc/compile-contract';
import { api } from '../../api';
import type { LaTeXEngine } from '../../types';

/**
 * Cached capability probe. Probing spawns each binary with `--version`, so we
 * do it once per session. The Settings panel calls {@link refreshLatexCapabilities}
 * when it wants a fresh read (e.g. the user installed TeX Live mid-session).
 */
let capsPromise: Promise<LaTeXCapabilities> | null = null;

export function getLatexCapabilities(): Promise<LaTeXCapabilities> {
  if (!capsPromise) {
    capsPromise = api.compile.getLaTeXCapabilities();
  }
  return capsPromise;
}

export function refreshLatexCapabilities(): Promise<LaTeXCapabilities> {
  capsPromise = api.compile.getLaTeXCapabilities();
  return capsPromise;
}

/**
 * Resolve `auto` to a concrete engine. Preference order favours engines that
 * can render CJK (xelatex/lualatex/tectonic) and are local (fast, uses the
 * user's own TeX Live + fonts), then the WASM engine as the always-available
 * fallback.
 *
 * pdflatex is intentionally NOT in the chain: it can't do Unicode/fontspec/CJK,
 * so it's a poor automatic default — wasm-xetex is a better fallback. Users who
 * specifically want pdflatex can still select it explicitly.
 */
export function resolveAutoLatexEngine(caps: LaTeXCapabilities): LaTeXEngine {
  if (caps.cli.xelatex.available) return 'xelatex';
  if (caps.cli.lualatex.available) return 'lualatex';
  if (caps.cli.tectonic.available) return 'tectonic';
  return 'wasm-xetex';
}

/** True when `engine` names a local CLI engine (vs a wasm-* engine). */
export function isLocalLatexEngine(engine: string): boolean {
  return (
    engine === 'xelatex' || engine === 'lualatex' || engine === 'tectonic' || engine === 'pdflatex'
  );
}
