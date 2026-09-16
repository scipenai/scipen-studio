/**
 * Tests for the WASM prewarm eligibility memory.
 *
 * Context: warming the in-renderer WASM engine moves ~120 MB and grows the
 * Emscripten heap by hundreds of MB. Doing that on every project open froze
 * the app for ~20 s even when the user never compiled. The prewarm is now a
 * learned optimisation — only projects with a prior successful WASM compile
 * are eligible — so this policy is what keeps the cost off people who don't
 * benefit.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../src/renderer/src/services/StorageService', () => ({
  getStorageService: () => ({
    get: (key: string) => store.get(key),
    store: (key: string, value: unknown) => store.set(key, value),
  }),
}));

import {
  clearWasmCompileMemory,
  hasCompiledWithWasm,
  rememberWasmCompile,
} from '../../../src/renderer/src/services/core/wasmPrewarmMemory';

beforeEach(() => {
  store.clear();
});

describe('wasm prewarm memory', () => {
  it('reports a project as ineligible until it has compiled', () => {
    expect(hasCompiledWithWasm('/p/paper')).toBe(false);
    rememberWasmCompile('/p/paper');
    expect(hasCompiledWithWasm('/p/paper')).toBe(true);
  });

  it('keeps projects independent', () => {
    rememberWasmCompile('/p/a');
    expect(hasCompiledWithWasm('/p/a')).toBe(true);
    expect(hasCompiledWithWasm('/p/b')).toBe(false);
  });

  it('treats a missing project path as ineligible instead of throwing', () => {
    expect(hasCompiledWithWasm(null)).toBe(false);
    expect(hasCompiledWithWasm(undefined)).toBe(false);
    expect(hasCompiledWithWasm('')).toBe(false);
    // Recording a null path must be a no-op, not a stored empty entry.
    rememberWasmCompile(null);
    expect(hasCompiledWithWasm(null)).toBe(false);
  });

  it('deduplicates and moves a repeat compile to the front', () => {
    rememberWasmCompile('/p/a');
    rememberWasmCompile('/p/b');
    rememberWasmCompile('/p/a');
    const stored = store.get('compile.wasmPrewarmProjects') as string[];
    expect(stored).toEqual(['/p/a', '/p/b']);
  });

  it('caps the list so the entry cannot grow without bound', () => {
    for (let i = 0; i < 25; i += 1) rememberWasmCompile(`/p/project-${i}`);
    const stored = store.get('compile.wasmPrewarmProjects') as string[];
    expect(stored).toHaveLength(20);
    // Newest kept, oldest evicted.
    expect(stored[0]).toBe('/p/project-24');
    expect(stored).not.toContain('/p/project-0');
  });

  it('skips the write when the path is already newest', () => {
    rememberWasmCompile('/p/a');
    const first = store.get('compile.wasmPrewarmProjects');
    rememberWasmCompile('/p/a');
    // Same array instance => no redundant localStorage write on every compile.
    expect(store.get('compile.wasmPrewarmProjects')).toBe(first);
  });

  it('survives a corrupt stored value', () => {
    store.set('compile.wasmPrewarmProjects', { not: 'an array' });
    expect(hasCompiledWithWasm('/p/a')).toBe(false);
    rememberWasmCompile('/p/a');
    expect(hasCompiledWithWasm('/p/a')).toBe(true);
  });

  it('clears the memory on request', () => {
    rememberWasmCompile('/p/a');
    clearWasmCompileMemory();
    expect(hasCompiledWithWasm('/p/a')).toBe(false);
  });
});
