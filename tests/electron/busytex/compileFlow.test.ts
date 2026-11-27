/**
 * Tests for the compile flow's incremental rules — injection, what gets
 * stored, and when a failure is retried cold — with every effect faked.
 */

import { describe, expect, it } from 'vitest';
import { BuildArtifactCache } from '../../../src/main/busytex-process/buildArtifactCache';
import {
  COLD_RETRY_NOTE,
  type CompileFlowDeps,
  type CompileFrame,
  type FlowFile,
  runCompileFlow,
} from '../../../src/main/busytex-process/compileFlow';
import type { PassTrace } from '../../../src/main/busytex-process/passPolicy';
import type { StageResult } from '../../../src/main/busytex-process/projectStager';

const bytes = (s: string) => new TextEncoder().encode(s);

const params = {
  projectRoot: '/proj',
  mainFileAbs: '/proj/main.tex',
  overlay: { absPath: '/proj/main.tex', contents: 'x' },
  outputDir: '/proj',
  baseName: 'main',
  driver: 'xetex_bibtex8_dvipdfmx',
  endpoint: '',
};

const trace = (overrides: Partial<PassTrace> = {}): PassTrace => ({
  passes: [],
  texPasses: 1,
  converged: true,
  halted: false,
  firstError: null,
  regenerated: [],
  ...overrides,
});

const clean = (): Outcome => ({ frame: { exit_code: 0, log: 'ok' }, trace: trace() });
/** A clean run in which bibtex rewrote main.bbl. */
const bibtexRan = (): Outcome => ({
  frame: { exit_code: 0, log: 'ok' },
  trace: trace({ regenerated: ['main.bbl'] }),
});
const halted = (firstError: string | null = '! Boom.\nl.3 x'): Outcome => ({
  frame: { exit_code: 0, log: 'halted' },
  trace: trace({ halted: true, firstError }),
});

interface Outcome {
  frame?: CompileFrame;
  throws?: Error;
  trace?: PassTrace;
}

function harness(outcomes: Outcome[], options: { staged?: string[]; timeoutMs?: number } = {}) {
  const cache = new BuildArtifactCache('');
  const calls: Array<{ files: FlowFile[]; timeoutMs: number }> = [];
  let clock = 0;
  let pending: PassTrace | undefined;
  const collected: Array<{ path: string; bytes: Uint8Array }> = [];
  const sourcesSeen: Array<ReadonlySet<string>> = [];
  const staged: StageResult = {
    files: (options.staged ?? ['main.tex']).map((path) => ({ path, contents: 'src' })),
    mainFile: 'main.tex',
    stats: {} as StageResult['stats'],
  };
  const packagesRecorded: string[][] = [];
  const deps: CompileFlowDeps = {
    stage: () => staged,
    run: async (files, _main, timeoutMs) => {
      calls.push({ files, timeoutMs });
      const next = outcomes[calls.length - 1] ?? clean();
      clock += 1000;
      pending = next.trace;
      if (next.throws) throw next.throws;
      return { ...(next.frame as CompileFrame) };
    },
    takeTrace: () => {
      const t = pending;
      pending = undefined;
      return t;
    },
    collectArtifacts: async (sources) => {
      sourcesSeen.push(sources);
      return collected;
    },
    enabledPackages: async () => ['texlive-extra.js'],
    cache,
    assetVersion: 'v1',
    timeoutMs: options.timeoutMs ?? 600_000,
    caseInsensitive: true,
    now: () => clock,
  };
  const origRecord = cache.recordPackages.bind(cache);
  cache.recordPackages = (root, pkgs) => {
    packagesRecorded.push(pkgs);
    origRecord(root, pkgs);
  };
  const key = cache.key({
    root: '/proj',
    mainFile: 'main.tex',
    driver: params.driver,
    assetVersion: 'v1',
    endpoint: '',
  });
  return { deps, cache, calls, collected, key, packagesRecorded, sourcesSeen };
}

const paths = (files: FlowFile[]) => files.map((f) => `${f.path}${f.injected ? '*' : ''}`).sort();

describe('runCompileFlow — injection and storage', () => {
  it('stores a clean run and injects it into the next compile', async () => {
    const h = harness([clean(), clean()]);
    h.collected.push({ path: 'main.aux', bytes: bytes('\\relax') });

    const first = await runCompileFlow(params, h.deps);
    expect(first.stored).toBe(true);
    expect(first.artifactsInjected).toBe(0);
    expect(h.packagesRecorded).toEqual([['texlive-extra.js']]);

    const second = await runCompileFlow(params, h.deps);
    expect(second.artifactsInjected).toBe(1);
    expect(paths(h.calls[1].files)).toEqual(['main.aux*', 'main.tex']);
  });

  it('lets a carried tool output take over a stale staged copy, whatever its casing', async () => {
    // A local latexmk build left Main.bbl on disk; bibtex rewrites it after
    // pass 1 anyway, so the carried copy is the better first-pass input.
    const h = harness([bibtexRan()], { staged: ['main.tex', 'Main.bbl'] });
    h.cache.put(h.key, [
      { path: 'main.bbl', bytes: bytes('carried') },
      { path: 'main.toc', bytes: bytes('toc') },
    ]);

    const result = await runCompileFlow(params, h.deps);
    expect(paths(h.calls[0].files)).toEqual(['main.bbl*', 'main.tex', 'main.toc*']);
    expect(h.calls).toHaveLength(1);
    expect(result.retriedCold).toBe(false);
  });

  it('reruns cold when no tool rewrote the staged file a carried copy replaced', async () => {
    // e.g. the document now \input's main.bbl by hand: the disk copy is the
    // real input, and the warm result typeset the carried one instead.
    const h = harness([clean(), clean()], { staged: ['main.tex', 'main.bbl'] });
    h.cache.put(h.key, [{ path: 'main.bbl', bytes: bytes('carried') }]);

    const result = await runCompileFlow(params, h.deps);
    expect(h.calls).toHaveLength(2);
    expect(paths(h.calls[1].files)).toEqual(['main.bbl', 'main.tex']);
    expect(result.retriedCold).toBe(true);
    expect(h.sourcesSeen[0]).toEqual(new Set(['main.bbl', 'main.tex']));
  });

  it('stores a staged file a tool rewrote as an artifact, not as a source', async () => {
    const h = harness([bibtexRan()], { staged: ['main.tex', 'main.bbl'] });

    await runCompileFlow(params, h.deps);
    expect(h.sourcesSeen[0]).toEqual(new Set(['main.tex']));
  });

  it('does not store artifacts from a halted run (truncated aux)', async () => {
    const h = harness([halted()]);
    const result = await runCompileFlow(params, h.deps);

    expect(result.stored).toBe(false);
    expect(h.cache.get(h.key)).toBeNull();
  });

  it('does not store artifacts from a run that exited non-zero', async () => {
    const h = harness([{ frame: { exit_code: 1, log: '' }, trace: trace() }]);
    expect((await runCompileFlow(params, h.deps)).stored).toBe(false);
  });

  it('does not store artifacts when a post-processor fails cleanly or with raw error', async () => {
    const h = harness([{ frame: { exit_code: 2, log: '' }, trace: trace({ halted: true }) }]);
    const result = await runCompileFlow(params, h.deps);

    expect(result.stored).toBe(false);
    expect(h.cache.get(h.key)).toBeNull();
  });
});

describe('runCompileFlow — cold retry', () => {
  it('retries without the carried artifacts when a warm compile fails', async () => {
    const h = harness([halted(), clean()]);
    h.cache.put(h.key, [{ path: 'main.aux', bytes: bytes('stale') }]);

    const result = await runCompileFlow(params, h.deps);

    expect(h.calls).toHaveLength(2);
    expect(paths(h.calls[1].files)).toEqual(['main.tex']);
    expect(result.retriedCold).toBe(true);
    expect(result.stored).toBe(true);
    expect(result.frame.log?.startsWith(COLD_RETRY_NOTE)).toBe(true);
  });

  it('does not retry when nothing was carried in', async () => {
    const h = harness([halted()]);
    const result = await runCompileFlow(params, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(result.retriedCold).toBe(false);
  });

  it('remembers a genuine error and skips the retry the next time it appears', async () => {
    const sig = '! Undefined control sequence.\nl.9 \\typo';
    const h = harness([halted(sig), halted(sig), halted(sig)]);
    h.cache.put(h.key, [{ path: 'main.aux', bytes: bytes('aux') }]);

    await runCompileFlow(params, h.deps); // warm fails, cold fails too → remembered
    expect(h.cache.coldFailure(h.key)).toBe(sig);

    await runCompileFlow(params, h.deps); // same error with artifacts → no retry
    expect(h.calls).toHaveLength(3);
  });

  it('retries again when the error changes', async () => {
    const h = harness([halted('! A.'), halted('! A.'), halted('! B.'), clean()]);
    h.cache.put(h.key, [{ path: 'main.aux', bytes: bytes('aux') }]);

    await runCompileFlow(params, h.deps);
    const result = await runCompileFlow(params, h.deps);

    expect(h.calls).toHaveLength(4);
    expect(result.retriedCold).toBe(true);
  });

  it('retries cold when the warm attempt throws, and rethrows without artifacts', async () => {
    const withArtifacts = harness([{ throws: new Error('FS error') }, clean()]);
    withArtifacts.cache.put(withArtifacts.key, [{ path: 'main.aux', bytes: bytes('aux') }]);
    expect((await runCompileFlow(params, withArtifacts.deps)).retriedCold).toBe(true);

    const without = harness([{ throws: new Error('engine call timed out') }]);
    await expect(runCompileFlow(params, without.deps)).rejects.toThrow('engine call timed out');
  });

  it('gives the retry only the time left on the shared deadline', async () => {
    const h = harness([halted(), clean()], { timeoutMs: 5000 });
    h.cache.put(h.key, [{ path: 'main.aux', bytes: bytes('aux') }]);

    await runCompileFlow(params, h.deps);
    expect(h.calls[0].timeoutMs).toBe(5000);
    expect(h.calls[1].timeoutMs).toBe(4000); // one fake second already spent
  });

  it('skips the retry once the deadline is spent', async () => {
    const h = harness([halted(), clean()], { timeoutMs: 1000 });
    h.cache.put(h.key, [{ path: 'main.aux', bytes: bytes('aux') }]);

    const result = await runCompileFlow(params, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(result.retriedCold).toBe(false);
  });
});
