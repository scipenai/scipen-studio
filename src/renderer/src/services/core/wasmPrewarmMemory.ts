/**
 * @file wasmPrewarmMemory.ts — remembers which projects actually compile
 *   with the in-renderer WASM engines.
 *
 * Warming those engines costs ~120 MB of data movement and a large Emscripten
 * heap, so it is only worth doing for projects the user really compiles.
 * Recording a successful WASM compile here turns the prewarm into a learned
 * optimisation: the first visit pays the cold start (with visible progress),
 * later sessions start warm. A project opened to fix a typo never pays.
 *
 * Pure functions over StorageService so the policy is unit-testable without
 * a CompileService instance.
 */

import { getStorageService } from '../StorageService';

const STORAGE_KEY = 'compile.wasmPrewarmProjects';

/**
 * Cap on remembered projects. Keeps the entry small and self-pruning; the
 * least-recently-compiled path is dropped when the cap is hit.
 */
const MAX_REMEMBERED_PROJECTS = 20;

function readProjects(): string[] {
  const stored = getStorageService().get<unknown>(STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is string => typeof entry === 'string');
}

/** True when a WASM compile has previously succeeded in this project. */
export function hasCompiledWithWasm(projectPath: string | null | undefined): boolean {
  if (!projectPath) return false;
  return readProjects().includes(projectPath);
}

/**
 * Record a successful WASM compile. Most-recent-first, deduplicated, capped.
 * Safe to call on every compile — a repeat just moves the path to the front.
 */
export function rememberWasmCompile(projectPath: string | null | undefined): void {
  if (!projectPath) return;
  const existing = readProjects();
  if (existing[0] === projectPath) return; // already newest, nothing to write
  const next = [projectPath, ...existing.filter((p) => p !== projectPath)].slice(
    0,
    MAX_REMEMBERED_PROJECTS
  );
  getStorageService().store(STORAGE_KEY, next);
}

/** Test/diagnostic helper: drop all remembered projects. */
export function clearWasmCompileMemory(): void {
  getStorageService().store(STORAGE_KEY, []);
}
