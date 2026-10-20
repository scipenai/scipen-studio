/**
 * Tests for the BusyTeX pass policy — the decision of how many TeX passes a
 * compile runs. The schedule is a pure function over injected effects, so
 * every scenario is scripted: the fingerprint sequence stands in for the
 * build artifacts TeX writes, and command results stand in for the engine.
 */

import { describe, expect, it } from 'vitest';
import {
  type CommandResult,
  type PassDeps,
  type PassPlan,
  type PassSeamContext,
  type PassTrace,
  firstErrorSignature,
  installPassPolicy,
  schedulePasses,
} from '../../../src/main/busytex-process/passPolicy';

const XETEX = ['xelatex', 'main.tex'];
const BIBTEX = ['bibtex8', 'main.aux'];
const MAKEINDEX = ['makeindex', 'main.idx'];
const DVI = ['xdvipdfmx', 'main.xdv'];

function plan(overrides: Partial<PassPlan> = {}): PassPlan {
  return {
    initial: XETEX,
    nonfinal: XETEX,
    final: XETEX,
    dvi: DVI,
    bibtex: false,
    bibtexCmd: BIBTEX,
    makeindex: null,
    makeindexCmd: MAKEINDEX,
    auxPath: 'main.aux',
    bblPath: 'main.bbl',
    idxPath: 'main.idx',
    indPath: 'main.ind',
    rerun: null,
    maxPasses: 3,
    finalForAllPasses: false,
    ...overrides,
  };
}

interface Script {
  /** Fingerprints in the order the policy asks for them (the last one repeats). */
  fingerprints: string[];
  /** Per-command results in order; missing entries mean a clean exit. */
  tex?: CommandResult[];
  tools?: Record<string, CommandResult>;
  /** File contents; functions are re-read on every call. */
  files?: Record<string, string | (() => string)>;
}

function harness(script: Script) {
  const ran: string[][] = [];
  const printed: string[] = [];
  let fp = 0;
  let texCall = 0;
  const ok = (log = ''): CommandResult => ({ exit_code: 0, raw_exit_code: 0, log });
  const read = (path: string): string => {
    const entry = script.files?.[path];
    return typeof entry === 'function' ? entry() : (entry ?? '');
  };
  const deps: PassDeps = {
    runTex: (cmd) => {
      ran.push(cmd);
      return script.tex?.[texCall++] ?? ok();
    },
    runTool: (cmd) => {
      ran.push(cmd);
      return script.tools?.[cmd[0]] ?? ok();
    },
    fingerprint: () => script.fingerprints[Math.min(fp++, script.fingerprints.length - 1)],
    readText: read,
    exists: (path) => script.files?.[path] !== undefined,
    print: (message) => printed.push(message),
    now: () => 0,
  };
  return { deps, ran, printed };
}

const commandNames = (ran: string[][]) => ran.map((cmd) => cmd[0]);

describe('schedulePasses — convergence', () => {
  it('stops after one pass when the artifacts did not change (incremental steady state)', () => {
    const h = harness({ fingerprints: ['A', 'A'] });
    const { trace, exitCode } = schedulePasses(plan(), h.deps);

    expect(trace.texPasses).toBe(1);
    expect(trace.converged).toBe(true);
    expect(exitCode).toBe(0);
    expect(commandNames(h.ran)).toEqual(['xelatex', 'xdvipdfmx']);
  });

  it('reruns while artifacts change and stops at the fixed point', () => {
    const h = harness({ fingerprints: ['empty', 'aux1', 'aux2', 'aux2'] });
    const { trace } = schedulePasses(plan(), h.deps);

    expect(trace.texPasses).toBe(3);
    expect(trace.converged).toBe(true);
  });

  it('caps at the initial pass plus maxPasses when TeX never settles', () => {
    const h = harness({ fingerprints: ['0', '1', '2', '3', '4', '5'] });
    const { trace } = schedulePasses(plan(), h.deps);

    expect(trace.texPasses).toBe(4);
    expect(trace.converged).toBe(false);
  });

  it('does not rerun because a log mentions rerunfilecheck (the old false positive)', () => {
    // hyperref loads the rerunfilecheck package on every run; upstream's log
    // grep treated that line as a rerun request and always ran 4 passes.
    const log = '(/texlive/texmf-dist/tex/latex/rerunfilecheck/rerunfilecheck.sty';
    const h = harness({
      fingerprints: ['A', 'A'],
      tex: [{ exit_code: 0, raw_exit_code: 0, log }],
    });

    expect(schedulePasses(plan(), h.deps).trace.texPasses).toBe(1);
  });

  it('runs only the initial pass when the caller disables reruns', () => {
    const h = harness({ fingerprints: ['A', 'B'] });
    const { trace } = schedulePasses(plan({ rerun: false }), h.deps);

    expect(trace.texPasses).toBe(1);
    expect(h.printed).toContain('$ # rerun disabled by caller, running initial pass only');
  });
});

describe('schedulePasses — halted passes', () => {
  const halted = (effective: number): CommandResult => ({
    exit_code: effective,
    raw_exit_code: 1,
    log: '! Undefined control sequence.\nl.42 \\foo\n',
  });

  it('stops typesetting on a non-zero raw exit even when upstream reports 0', () => {
    // batchmode stdout is only the banner, so upstream's effective code reads
    // a --halt-on-error pass as success and used to typeset it again.
    const h = harness({ fingerprints: ['A', 'B', 'C'], tex: [halted(0)] });
    const { trace, exitCode } = schedulePasses(plan(), h.deps);

    expect(trace.texPasses).toBe(1);
    expect(trace.halted).toBe(true);
    expect(trace.firstError).toBe('! Undefined control sequence.\nl.42 \\foo');
    // The partial output is still converted so the PDF stays viewable.
    expect(commandNames(h.ran)).toEqual(['xelatex', 'xdvipdfmx']);
    expect(exitCode).toBe(0);
  });

  it('skips conversion when the halted pass is reported as a failure', () => {
    const h = harness({ fingerprints: ['A', 'B'], tex: [halted(1)] });
    const { exitCode } = schedulePasses(plan(), h.deps);

    expect(commandNames(h.ran)).toEqual(['xelatex']);
    expect(exitCode).toBe(1);
  });

  it('falls back to the effective code on an unpatched pipeline without raw_exit_code', () => {
    const h = harness({ fingerprints: ['A', 'A'], tex: [{ exit_code: 0, log: '' }] });
    expect(schedulePasses(plan(), h.deps).trace.halted).toBe(false);
  });
});

describe('schedulePasses — post-processors', () => {
  it('runs bibtex once after the first pass and disables it when no citations exist', () => {
    const h = harness({ fingerprints: ['A', 'A'], files: { 'main.bbl': '   ' } });
    schedulePasses(plan({ bibtex: true }), h.deps);

    expect(commandNames(h.ran)).toEqual(['xelatex', 'bibtex8', 'xdvipdfmx']);
    expect(h.printed).toContain('$ # bibtex found no citation commands, skipping extra passes');
  });

  it('records the files the post-processors rewrote, once each', () => {
    let idx = '\\indexentry{a}{1}';
    const h = harness({
      fingerprints: ['0', '1', '1'],
      files: { 'main.bbl': '\\begin{thebibliography}', 'main.idx': () => idx, 'main.ind': 'x' },
    });
    h.deps.runTex = (cmd) => {
      h.ran.push(cmd);
      idx = `\\indexentry{a}{${h.ran.length}}`;
      return { exit_code: 0, raw_exit_code: 0, log: '' };
    };
    const { trace } = schedulePasses(plan({ bibtex: true }), h.deps);

    expect(commandNames(h.ran).filter((c) => c === 'makeindex')).toHaveLength(2);
    expect(trace.regenerated).toEqual(['main.bbl', 'main.ind']);
  });

  it('records nothing when no post-processor ran', () => {
    const h = harness({ fingerprints: ['A', 'A'] });
    expect(schedulePasses(plan(), h.deps).trace.regenerated).toEqual([]);
  });

  it('reruns bibtex only when the citation lines in the aux change', () => {
    let aux = '\\citation{a}\n\\bibdata{refs}';
    const h = harness({
      fingerprints: ['0', '1', '2', '2'],
      files: { 'main.aux': () => aux, 'main.bbl': '\\begin{thebibliography}' },
    });
    h.deps.runTex = (cmd) => {
      h.ran.push(cmd);
      // The second pass discovers a citation inside a caption.
      if (h.ran.filter((c) => c[0] === 'xelatex').length === 2) aux += '\n\\citation{b}';
      return { exit_code: 0, raw_exit_code: 0, log: '' };
    };
    schedulePasses(plan({ bibtex: true }), h.deps);

    expect(commandNames(h.ran)).toEqual([
      'xelatex',
      'bibtex8',
      'xelatex',
      'bibtex8',
      'xelatex',
      'xdvipdfmx',
    ]);
  });

  it('reruns makeindex when page numbers in the .idx move', () => {
    let idx = '\\indexentry{a}{1}';
    const h = harness({
      fingerprints: ['0', '1', '1'],
      files: { 'main.idx': () => idx, 'main.ind': '\\begin{theindex}' },
    });
    h.deps.runTex = (cmd) => {
      h.ran.push(cmd);
      if (h.ran.filter((c) => c[0] === 'xelatex').length === 2) idx = '\\indexentry{a}{3}';
      return { exit_code: 0, raw_exit_code: 0, log: '' };
    };
    schedulePasses(plan(), h.deps);

    expect(commandNames(h.ran)).toEqual([
      'xelatex',
      'makeindex',
      'xelatex',
      'makeindex',
      'xdvipdfmx',
    ]);
  });

  it('stops everything, conversion included, when bibtex fails', () => {
    const h = harness({
      fingerprints: ['A', 'B'],
      tools: { bibtex8: { exit_code: 2, log: '' } },
    });
    const { exitCode } = schedulePasses(plan({ bibtex: true }), h.deps);

    expect(commandNames(h.ran)).toEqual(['xelatex', 'bibtex8']);
    expect(exitCode).toBe(2);
  });

  it('notes a caller-disabled makeindex', () => {
    const h = harness({ fingerprints: ['A', 'A'], files: { 'main.idx': 'x' } });
    schedulePasses(plan({ makeindex: false }), h.deps);

    expect(commandNames(h.ran)).not.toContain('makeindex');
    expect(h.printed).toContain('$ # makeindex disabled by caller');
  });
});

describe('schedulePasses — drivers with a distinct final command', () => {
  const PDF_NONFINAL = ['pdflatex', '--interaction=batchmode'];
  const PDF_FINAL = ['pdflatex', '--interaction=nonstopmode'];
  const pdftex = (overrides: Partial<PassPlan> = {}) =>
    plan({
      initial: PDF_NONFINAL,
      nonfinal: PDF_NONFINAL,
      final: PDF_FINAL,
      dvi: null,
      ...overrides,
    });

  it('owes a final pass after converging on the intermediate command', () => {
    const h = harness({ fingerprints: ['A', 'A'] });
    schedulePasses(pdftex(), h.deps);

    expect(h.ran).toEqual([PDF_NONFINAL, PDF_FINAL]);
  });

  it('runs the final command throughout once finalForAllPasses is on', () => {
    const h = harness({ fingerprints: ['A', 'A'] });
    schedulePasses(pdftex({ finalForAllPasses: true }), h.deps);

    expect(h.ran).toEqual([PDF_FINAL]);
  });

  it('uses the final command on the last budgeted pass, never adding a fifth', () => {
    const h = harness({ fingerprints: ['0', '1', '2', '3', '4'] });
    const { trace } = schedulePasses(pdftex(), h.deps);

    expect(trace.texPasses).toBe(4);
    expect(h.ran.at(-1)).toEqual(PDF_FINAL);
  });
});

describe('firstErrorSignature', () => {
  it('pairs the first error with its source line', () => {
    const log = 'noise\n! Missing $ inserted.\n<inserted text>\nl.7 a_b\n! Second error.';
    expect(firstErrorSignature(log)).toBe('! Missing $ inserted.\nl.7 a_b');
  });

  it('returns the bare error when no line context follows', () => {
    expect(firstErrorSignature('! Emergency stop.')).toBe('! Emergency stop.');
  });

  it('returns null for a clean log', () => {
    expect(firstErrorSignature('Output written on main.xdv')).toBeNull();
  });
});

describe('installPassPolicy', () => {
  it('returns false when there is no pipeline class to patch', () => {
    expect(installPassPolicy(undefined, { finalForAllPasses: false, fingerprint: () => '' })).toBe(
      false
    );
  });

  /** Install the policy on a fake class and run one seam call against a stub FS. */
  function runSeam(overrides: Partial<PassSeamContext> = {}) {
    class FakePipeline {
      scipen_last_trace?: PassTrace;
    }
    const seen: Array<ReadonlySet<string>> = [];
    installPassPolicy(FakePipeline, {
      finalForAllPasses: false,
      fingerprint: (_fs, _root, sources) => {
        seen.push(sources);
        return 'same';
      },
    });
    const instance = new FakePipeline() as FakePipeline & {
      scipen_run_passes: (ctx: PassSeamContext) => { exit_code: number; last_log: string };
    };
    const result = instance.scipen_run_passes({
      run: () => ({ exit_code: 0, raw_exit_code: 0, log: 'done' }),
      FS: { analyzePath: () => ({ exists: false }), readFile: () => '', cwd: () => '/project' },
      files: [],
      project_dir: '/project',
      initial: XETEX,
      nonfinal: XETEX,
      final_cmd: XETEX,
      dvi: DVI,
      bibtex: false,
      bibtex8_cmd: BIBTEX,
      makeindex: null,
      makeindex_cmd: MAKEINDEX,
      aux_path: 'main.aux',
      bbl_path: 'main.bbl',
      idx_path: 'main.idx',
      ind_path: 'main.ind',
      rerun: null,
      max_tex_passes: 3,
      error_messages_all: [],
      print: () => undefined,
      ...overrides,
    });
    return { result, sources: seen[0], trace: instance.scipen_last_trace };
  }

  it('binds the seam: injected artifacts stay in the fingerprint, sources do not', () => {
    const { result, sources, trace } = runSeam({
      files: [
        { path: 'main.tex', contents: '...' },
        { path: './images/a.png', contents: new Uint8Array() },
        { path: 'main.aux', contents: '\\relax', injected: true },
        { path: 'chapters', contents: null },
      ],
    });

    expect(result).toEqual({ exit_code: 0, last_log: 'done' });
    expect([...sources].sort()).toEqual(['images/a.png', 'main.tex']);
    expect(trace?.texPasses).toBe(1);
  });

  it('treats a staged tool output as a product and reports it project-relative', () => {
    // Main file in a subdir: upstream chdirs there and names tool outputs
    // relative to it, while staged paths are relative to the project.
    const { sources, trace } = runSeam({
      FS: {
        // No .idx: only bibtex runs.
        analyzePath: (path) => ({ exists: !path.endsWith('.idx') }),
        readFile: () => '\\begin{thebibliography}',
        cwd: () => '/project/src',
      },
      files: [
        { path: 'src/main.tex', contents: '...' },
        { path: 'src/main.bbl', contents: 'stale, from a local latexmk build' },
      ],
      bibtex: true,
    });

    expect([...sources]).toEqual(['src/main.tex']);
    expect(trace?.regenerated).toEqual(['src/main.bbl']);
  });
});
