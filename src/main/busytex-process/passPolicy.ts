/**
 * @file busytex-process/passPolicy.ts — how many TeX passes a compile runs
 *
 * Owns the multi-pass schedule behind the `pass-seam` patch in the vendored
 * busytex_pipeline.js (see scripts/patch-busytex-pipeline.js). Upstream keeps
 * everything else — package resolution, data-package reloads, the per-driver
 * command table, log assembly — so upstream improvements still flow in; only
 * this decision moved here, where it is typed and unit-tested.
 *
 * Why upstream's schedule could not stay:
 *   - it decides "rerun?" by grepping the log, and one pattern
 *     ('rerunfilecheck') is a package NAME that hyperref loads — every
 *     hyperref document ran the maximum 4 passes;
 *   - its effective exit code reads only stdout, which batchmode reduces to
 *     the banner, so a `--halt-on-error` pass counted as success and the loop
 *     typeset the broken document again;
 *   - after a converged initial pass it re-ran the identical command once
 *     more for the xetex driver.
 *
 * Here a pass is repeated only while the build artifacts (aux, toc, out, …)
 * keep changing — the latexmk criterion — and any non-zero raw TeX exit stops
 * typesetting at once.
 *
 * Loaded by the bundled engine host AND directly by Node (scripts/bench via
 * type stripping): node builtins only, erasable TS syntax only, no relative
 * imports (the fingerprint function is injected).
 */

/**
 * Run the driver's final command for every pass, so no driver needs a
 * separate closing pass. Verified on all bundled templates for the two
 * drivers whose commands differ (pdftex: batchmode vs nonstopmode; luahbtex:
 * an explicit `--output-format=pdf` its format already defaults to): PDFs are
 * byte-identical once timestamps and document IDs are neutralised, and every
 * template saves one pass. xetex and luatex use one command throughout and
 * are unaffected. Re-verify when bumping the BusyTeX tarball.
 */
export const FINAL_FOR_ALL_PASSES = true;

/** Result of one command, as returned by the patched `_run_cmd`. */
export interface CommandResult {
  /** Upstream's effective code: forced to 0 when stdout shows no known error. */
  exit_code: number;
  /** The process's real exit status (`raw-exit-code` patch); absent on an unpatched pipeline. */
  raw_exit_code?: number;
  log: string;
}

export interface PassPlan {
  initial: string[];
  nonfinal: string[];
  final: string[];
  dvi: string[] | null;
  bibtex: boolean;
  bibtexCmd: string[];
  /** null = upstream default (on when an index exists), false = disabled by caller. */
  makeindex: boolean | null;
  makeindexCmd: string[];
  auxPath: string;
  bblPath: string;
  idxPath: string;
  indPath: string;
  /** null/true = schedule reruns, false = initial pass only (upstream contract). */
  rerun: boolean | null;
  /** Extra passes allowed after the initial one (upstream `max_tex_passes`). */
  maxPasses: number;
  /**
   * Run `final` for every pass. Always true when the driver's initial and
   * final commands are the same; for the others it is a verified opt-in.
   */
  finalForAllPasses: boolean;
}

export interface PassDeps {
  runTex(cmd: string[]): CommandResult;
  runTool(cmd: string[]): CommandResult;
  fingerprint(): string;
  /** File text relative to the compile's working dir; '' when absent. */
  readText(path: string): string;
  exists(path: string): boolean;
  print(message: string): void;
  now(): number;
}

export interface PassRecord {
  cmd: string;
  ms: number;
  raw: number;
  effective: number;
}

export interface PassTrace {
  passes: PassRecord[];
  texPasses: number;
  /** Artifacts stopped changing before the pass budget ran out. */
  converged: boolean;
  /** A TeX pass exited non-zero; typesetting stopped there. */
  halted: boolean;
  /** First `!` line plus its `l.<n>` context, from the halted pass. */
  firstError: string | null;
  /**
   * Files a post-processor rewrote (bibtex's .bbl, makeindex's .ind): products
   * of this compile even when a copy was staged from disk. Project-relative
   * once bound at the seam.
   */
  regenerated: string[];
}

export interface PassOutcome {
  exitCode: number;
  lastLog: string;
  trace: PassTrace;
}

/** First TeX error and its source-line context — a stable identity for "the same error". */
export function firstErrorSignature(log: string): string | null {
  const lines = log.split('\n');
  const at = lines.findIndex((line) => line.startsWith('!'));
  if (at < 0) return null;
  const context = lines.slice(at + 1, at + 9).find((line) => /^l\.\d+/.test(line));
  return context ? `${lines[at].trim()}\n${context.trim()}` : lines[at].trim();
}

/** The aux lines bibtex consumes; bibtex only needs to run again when they change. */
function citationSignature(auxText: string): string {
  return auxText
    .split('\n')
    .filter((line) => /^\\(citation|bibdata|bibstyle)\{/.test(line))
    .join('\n');
}

export function schedulePasses(plan: PassPlan, deps: PassDeps): PassOutcome {
  const trace: PassTrace = {
    passes: [],
    texPasses: 0,
    converged: false,
    halted: false,
    firstError: null,
    regenerated: [],
  };
  const sameCommand = plan.initial === plan.final || plan.finalForAllPasses;
  let exitCode = 0;
  let lastLog = '';

  const record = (cmd: string[], t0: number, r: CommandResult): number => {
    const raw = r.raw_exit_code ?? r.exit_code;
    trace.passes.push({
      cmd: cmd[0] ?? '',
      ms: Math.round(deps.now() - t0),
      raw,
      effective: r.exit_code,
    });
    exitCode = r.exit_code;
    return raw;
  };

  /** One TeX pass; false when it halted (raw non-zero). */
  const tex = (cmd: string[]): boolean => {
    const t0 = deps.now();
    const r = deps.runTex(cmd);
    const raw = record(cmd, t0, r);
    trace.texPasses += 1;
    lastLog = r.log;
    if (raw === 0) return true;
    trace.halted = true;
    trace.firstError = firstErrorSignature(r.log);
    return false;
  };

  /** bibtex / makeindex / xdvipdfmx; false when the tool failed. */
  const tool = (cmd: string[]): boolean => {
    const t0 = deps.now();
    const raw = record(cmd, t0, deps.runTool(cmd));
    if (raw === 0) return true;
    // Propagate non-zero raw codes even if effective exit_code stayed 0 so
    // downstream conversion and artifact caching never see a clean compile.
    exitCode = raw;
    trace.halted = true;
    return false;
  };

  /** A post-processor run; its output now belongs to this compile. */
  const regenerate = (cmd: string[], output: string): boolean => {
    if (!tool(cmd)) return false;
    if (!trace.regenerated.includes(output)) trace.regenerated.push(output);
    return true;
  };

  let bibtexActive = plan.bibtex;
  let citations = '';
  let makeindexActive = false;
  let indexInput = '';

  const postProcessFirst = (): boolean => {
    if (bibtexActive) {
      citations = citationSignature(deps.readText(plan.auxPath));
      if (!regenerate(plan.bibtexCmd, plan.bblPath)) return false;
      if (deps.readText(plan.bblPath).trim() === '') {
        deps.print('$ # bibtex found no citation commands, skipping extra passes');
        bibtexActive = false;
      }
    }
    const makeindexEnabled = plan.makeindex === null ? true : plan.makeindex;
    indexInput = deps.exists(plan.idxPath) ? deps.readText(plan.idxPath) : '';
    makeindexActive = makeindexEnabled && indexInput.trim() !== '';
    if (makeindexActive) {
      if (!regenerate(plan.makeindexCmd, plan.indPath)) return false;
      if (deps.readText(plan.indPath).trim() === '') {
        deps.print('$ # makeindex produced no index entries, skipping extra passes');
        makeindexActive = false;
      }
    } else if (plan.makeindex === false) {
      deps.print('$ # makeindex disabled by caller');
    }
    return true;
  };

  /**
   * Re-run a post-processor only when its input moved. Citations are fixed
   * after the first pass, but index page numbers shift once a table of
   * contents pushes the body down, so a cold compile's `.ind` would
   * otherwise carry first-pass page numbers.
   */
  const postProcessAgain = (): boolean => {
    if (bibtexActive) {
      const next = citationSignature(deps.readText(plan.auxPath));
      if (next !== citations) {
        citations = next;
        if (!regenerate(plan.bibtexCmd, plan.bblPath)) return false;
      }
    }
    if (makeindexActive) {
      const next = deps.readText(plan.idxPath);
      if (next !== indexInput) {
        indexInput = next;
        if (!regenerate(plan.makeindexCmd, plan.indPath)) return false;
      }
    }
    return true;
  };

  let before = deps.fingerprint();
  let lastCmd = sameCommand ? plan.final : plan.initial;
  let ok = tex(lastCmd) && postProcessFirst();

  if (ok && plan.rerun === false) {
    deps.print('$ # rerun disabled by caller, running initial pass only');
  } else if (ok) {
    for (let pass = 0; pass < plan.maxPasses; pass++) {
      const after = deps.fingerprint();
      if (after === before) {
        trace.converged = true;
        break;
      }
      before = after;
      const isLast = pass === plan.maxPasses - 1;
      lastCmd = sameCommand || isLast ? plan.final : plan.nonfinal;
      ok = tex(lastCmd) && postProcessAgain();
      if (!ok) break;
    }
    if (ok && !trace.converged) trace.converged = deps.fingerprint() === before;
    // Drivers whose final command differs still owe one final pass after
    // converging on the intermediate command (upstream's contract).
    if (ok && lastCmd !== plan.final) {
      ok = tex(plan.final);
      lastCmd = plan.final;
    }
  }

  // A halted pass with an effective code of 0 still converts: the partial
  // PDF stays viewable while the log carries the error (Overleaf convention).
  if (exitCode === 0 && plan.dvi) tool(plan.dvi);

  return { exitCode, lastLog, trace };
}

// ====== Seam binding ======

/** What the patched pipeline hands over at the seam (see pass-seam patch). */
export interface PassSeamContext {
  run(cmd: string[], errorMessages: string[]): CommandResult;
  FS: SeamFs;
  files: Array<{ path: string; contents?: unknown; injected?: boolean }>;
  project_dir: string;
  initial: string[];
  nonfinal: string[];
  final_cmd: string[];
  dvi: string[] | null;
  bibtex: boolean;
  bibtex8_cmd: string[];
  makeindex: boolean | null;
  makeindex_cmd: string[];
  aux_path: string;
  bbl_path: string;
  idx_path: string;
  ind_path: string;
  rerun: boolean | null;
  max_tex_passes: number;
  error_messages_all: string[];
  print(message: string): void;
}

/** The FS calls this binding needs; the fingerprint function brings its own. */
export interface SeamFs {
  analyzePath(path: string): { exists: boolean };
  readFile(path: string, opts: { encoding: 'utf8' }): string;
  /** The main file's dir: upstream chdirs there, and tool paths are relative to it. */
  cwd(): string;
}

export interface PassPolicyOptions {
  /** See PassPlan.finalForAllPasses — the opt-in for drivers with distinct commands. */
  finalForAllPasses: boolean;
  fingerprint(fs: never, root: string, sourcePaths: ReadonlySet<string>): string;
}

function stagedName(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/** Project-relative form of a path upstream gives relative to the main file's dir. */
function projectRelative(cwd: string, projectDir: string, path: string): string {
  const dir = cwd.startsWith(projectDir) ? stagedName(cwd.slice(projectDir.length)) : '';
  return dir ? `${dir}/${path}` : path;
}

/**
 * Install the policy on the pipeline class. Returns false when there is no
 * class to patch (e.g. a fixture worker), in which case the seam falls back
 * to upstream's schedule. The last compile's trace is left on the instance
 * as `scipen_last_trace` for the host's stats.
 */
export function installPassPolicy(pipelineClass: unknown, options: PassPolicyOptions): boolean {
  const proto = (pipelineClass as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!proto) return false;

  proto.scipen_run_passes = function runPasses(
    this: { scipen_last_trace?: PassTrace },
    ctx: PassSeamContext
  ): { exit_code: number; last_log: string } {
    // Injected artifacts are products of the previous compile, not sources:
    // they must stay inside the fingerprint, or a rewritten .aux would never
    // count as a change. Tool outputs staged from disk are no sources either:
    // bibtex rewrites a stale main.bbl left by a local latexmk build after
    // pass 1, and that change must buy the pass that reads the new one.
    const toProject = (path: string) => projectRelative(ctx.FS.cwd(), ctx.project_dir, path);
    const toolOutputs = new Set([toProject(ctx.bbl_path), toProject(ctx.ind_path)]);
    const sources = new Set(
      ctx.files
        .filter((f) => !f.injected && f.contents != null)
        .map((f) => stagedName(f.path))
        .filter((path) => !toolOutputs.has(path))
    );
    const deps: PassDeps = {
      runTex: (cmd) => ctx.run(cmd, ctx.error_messages_all),
      runTool: (cmd) => ctx.run(cmd, ctx.error_messages_all),
      fingerprint: () => options.fingerprint(ctx.FS as never, ctx.project_dir, sources),
      readText: (path) =>
        ctx.FS.analyzePath(path).exists ? ctx.FS.readFile(path, { encoding: 'utf8' }) : '',
      exists: (path) => ctx.FS.analyzePath(path).exists,
      print: (message) => ctx.print(message),
      now: () => performance.now(),
    };
    const outcome = schedulePasses(
      {
        initial: ctx.initial,
        nonfinal: ctx.nonfinal,
        final: ctx.final_cmd,
        dvi: ctx.dvi,
        bibtex: Boolean(ctx.bibtex),
        bibtexCmd: ctx.bibtex8_cmd,
        makeindex: ctx.makeindex,
        makeindexCmd: ctx.makeindex_cmd,
        auxPath: ctx.aux_path,
        bblPath: ctx.bbl_path,
        idxPath: ctx.idx_path,
        indPath: ctx.ind_path,
        rerun: ctx.rerun,
        maxPasses: ctx.max_tex_passes,
        finalForAllPasses: options.finalForAllPasses,
      },
      deps
    );
    outcome.trace.regenerated = outcome.trace.regenerated.map(toProject);
    this.scipen_last_trace = outcome.trace;
    return { exit_code: outcome.exitCode, last_log: outcome.lastLog };
  };
  return true;
}
