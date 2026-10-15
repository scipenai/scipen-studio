/**
 * @file WASMCompilerProvider.test.ts — engine result → CompileResult mapping
 * @description The BusyTeX engine runs in a UtilityProcess and writes its
 * artifacts itself, so the provider's whole job after staging is to turn the
 * engine's `{ success, exitCode, pdfPath, log, errors }` into the result the
 * UI acts on. These tests pin the three rules that are easy to regress:
 *   - a cancel is neutral, never a red failure;
 *   - "exit 0 but the TeX log has `!` errors" is a FAILURE that still points
 *     at the partial PDF the engine already wrote (Overleaf convention);
 *   - real TeX errors from the log outrank the handler's generic message.
 * @depends vitest, CompilerProviders
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const busyTeXCompile = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/src/api', () => ({
  api: { compile: { busyTeXCompile } },
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getSettingsService: () => ({
    getSettings: () => ({ compiler: { texliveEndpoint: '' } }),
  }),
}));

import { WASMCompilerProvider } from '../../../src/renderer/src/services/core/CompilerProviders';

const HALTED_LOG = [
  '$ xelatex -synctex=1 --interaction=batchmode --halt-on-error --no-pdf main.tex',
  '! Undefined control sequence.',
  'l.42 \\foo',
  'Output written on main.xdv (3 pages).',
].join('\n');

/** No projectPath → staging uses only the editor buffer, no file IPC. */
function compile(): ReturnType<WASMCompilerProvider['compile']> {
  return new WASMCompilerProvider().compile('/proj/main.tex', '\\documentclass{article}', {
    engine: 'wasm-xetex',
  });
}

describe('WASMCompilerProvider', () => {
  beforeEach(() => {
    busyTeXCompile.mockReset();
  });

  it('reports a clean compile as success with the engine-written paths', async () => {
    busyTeXCompile.mockResolvedValue({
      success: true,
      exitCode: 0,
      pdfPath: '/proj/main.pdf',
      synctexPath: '/proj/main.synctex.gz',
      log: 'Output written on main.pdf (3 pages).',
      errors: [],
    });

    const result = await compile();

    expect(result.success).toBe(true);
    expect(result.pdfPath).toBe('/proj/main.pdf');
    expect(result.synctexPath).toBe('/proj/main.synctex.gz');
  });

  it('flips exit-0-with-log-errors to failure but keeps the partial PDF', async () => {
    // xdvipdfmx (the last driver step) converted the partial .xdv fine, so
    // the engine says exit 0 — the log is the only truthful signal.
    busyTeXCompile.mockResolvedValue({
      success: true,
      exitCode: 0,
      pdfPath: '/proj/main.pdf',
      synctexPath: '/proj/main.synctex.gz',
      log: HALTED_LOG,
      errors: [],
    });

    const result = await compile();

    expect(result.success).toBe(false);
    expect(result.pdfPath).toBe('/proj/main.pdf');
    expect(result.parsedErrors).toEqual([{ line: 42, message: '! Undefined control sequence.' }]);
  });

  it('prefers TeX log errors over the generic engine failure message', async () => {
    busyTeXCompile.mockResolvedValue({
      success: false,
      exitCode: 1,
      log: HALTED_LOG,
      errors: ['Compilation failed'],
    });

    const result = await compile();

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['! Undefined control sequence.']);
  });

  it('falls back to the engine-reported error when the log has none', async () => {
    // e.g. the 600 s request cap: no TeX error, only the transport's reason.
    busyTeXCompile.mockResolvedValue({
      success: false,
      log: '',
      errors: ["BusyTeX request 'compile' timed out"],
    });

    const result = await compile();

    expect(result.errors).toEqual(["BusyTeX request 'compile' timed out"]);
    expect(result.parsedErrors).toBeUndefined();
  });

  it('maps an engine teardown to a neutral cancelled result', async () => {
    busyTeXCompile.mockResolvedValue({ success: false, cancelled: true, log: '', errors: [] });

    const result = await compile();

    expect(result).toMatchObject({ success: false, cancelled: true, errors: [] });
  });
});
