/**
 * @file latexEngineResolver.ts - Resolve the `auto` LaTeX engine
 * @description The `auto` engine (default) means "prefer a locally-installed
 *              LaTeX, else fall back to the WASM engine". This module probes
 *              local capability once (cached) and resolves `auto` to a concrete
 *              engine at compile time, so the provider routing never sees
 *              `auto`. It also exposes a synchronous best-effort resolver so
 *              other readers of `settings.compiler.engine` (agent/chat context,
 *              status displays) don't surface the raw `auto` sentinel.
 */

import type { LaTeXCapabilities } from '../../../../../shared/ipc/compile-contract';
import { api } from '../../api';
import { LATEX_ENGINES } from '../../constants/latex';
import type { LaTeXEngine } from '../../types';

/**
 * Always-available fallback when no local LaTeX is detected (or a probe fails).
 */
const WASM_FALLBACK: LaTeXEngine = 'wasm-xetex';

/** Local CLI engines, in `auto` preference order (CJK-capable first). */
const AUTO_PREFERENCE: readonly LaTeXEngine[] = [
  LATEX_ENGINES.XELATEX,
  LATEX_ENGINES.LUALATEX,
  LATEX_ENGINES.TECTONIC,
];

/** All local CLI engines (used to tell local from wasm-* engines). */
const LOCAL_ENGINES: ReadonlySet<string> = new Set<string>([
  LATEX_ENGINES.XELATEX,
  LATEX_ENGINES.LUALATEX,
  LATEX_ENGINES.TECTONIC,
  LATEX_ENGINES.PDFLATEX,
]);

/**
 * Cached capability probe. Probing spawns each binary with `--version`, so we
 * do it once per session. On rejection we clear the cache so a later call can
 * retry — otherwise one transient failure would poison every future `auto`
 * compile for the session. {@link cachedCaps} holds the last resolved value
 * for synchronous best-effort resolution.
 */
let capsPromise: Promise<LaTeXCapabilities> | null = null;
let cachedCaps: LaTeXCapabilities | null = null;

export function getLatexCapabilities(): Promise<LaTeXCapabilities> {
  if (!capsPromise) {
    const chain: Promise<LaTeXCapabilities> = api.compile
      .getLaTeXCapabilities()
      .then((caps) => {
        // Only record if this is still the current probe — a concurrent
        // refresh may have superseded us with a newer result.
        if (capsPromise === chain) cachedCaps = caps;
        return caps;
      })
      .catch((error) => {
        // Allow the next call to retry — but only clear the cache if it still
        // points at THIS chain, so we don't clobber a concurrent refresh's
        // newer probe.
        if (capsPromise === chain) capsPromise = null;
        throw error;
      });
    capsPromise = chain;
  }
  return capsPromise;
}

export function refreshLatexCapabilities(): Promise<LaTeXCapabilities> {
  capsPromise = null;
  return getLatexCapabilities();
}

/**
 * Resolve `auto` to a concrete engine. Preference favours engines that can
 * render CJK (xelatex/lualatex/tectonic) and are local (fast, uses the user's
 * own TeX Live + fonts), then the WASM engine as the always-available fallback.
 *
 * pdflatex is intentionally NOT in the chain: it can't do Unicode/fontspec/CJK,
 * so it's a poor automatic default — wasm-xetex is a better fallback. Users who
 * specifically want pdflatex can still select it explicitly.
 */
export function resolveAutoLatexEngine(caps: LaTeXCapabilities): LaTeXEngine {
  for (const engine of AUTO_PREFERENCE) {
    if (caps.cli[engine as keyof LaTeXCapabilities['cli']]?.available) return engine;
  }
  return WASM_FALLBACK;
}

/** True when `engine` names a local CLI engine (vs a wasm-* engine). */
export function isLocalLatexEngine(engine: string): boolean {
  return LOCAL_ENGINES.has(engine);
}

/**
 * Synchronous best-effort resolution for non-compile readers (agent/chat
 * context, telemetry, displays). Returns `engine` unchanged unless it is
 * `auto` AND the probe has already completed, in which case it maps to the
 * concrete engine that will actually run. If no probe result is cached yet we
 * return `auto` verbatim — an honest "not yet resolved" beats guessing
 * `wasm-xetex` when the machine may actually resolve to local xelatex. Never
 * spawns work.
 */
export function resolveLatexEngineForDisplay(engine: string): string {
  if (engine !== LATEX_ENGINES.AUTO || !cachedCaps) return engine;
  return resolveAutoLatexEngine(cachedCaps);
}

/** Fire-and-forget warm-up so the first compile doesn't block on the probe. */
export function warmLatexCapabilities(): void {
  void getLatexCapabilities().catch(() => {
    // Non-fatal: _resolveAutoEngine handles a failed/absent probe.
  });
}
