/**
 * @file busytex-process/compileFlow.ts — one compile, end to end
 *
 * stage → inject the last clean run's artifacts → compile → keep artifacts
 * only from a clean run → retry cold when injected artifacts may be to blame.
 *
 * Effects are injected so the rules below are testable without an engine:
 *
 *   - Disk and the editor buffer are the truth; an artifact fills paths
 *     nothing staged provides. The one exception is a file a tool rewrites
 *     during the compile (in practice bibtex's .bbl beside a local latexmk
 *     build): the carried copy is the tool's last output and a better
 *     first-pass input than a stale disk copy. If no tool rewrote it after
 *     all, the staged copy was the real input and the compile reruns cold.
 *   - Only a clean run (no TeX pass halted, final exit 0) is stored. A pass
 *     stopped by --halt-on-error leaves a truncated .aux behind, and storing
 *     it would poison every later compile.
 *   - A failure with injected artifacts is retried once without them, since
 *     a stale artifact (an .aux mentioning a macro from a package the user
 *     just removed, a .toc read after the title page, …) can break a compile
 *     that would succeed cold. If the cold run fails with the same first
 *     error, that signature is remembered and not retried again — a genuine
 *     document error then costs one attempt, not two.
 *   - Both attempts share one deadline, so a retry can never push the call
 *     past the caller's request timeout.
 */

import type { BuildArtifactCache, CachedArtifact } from './buildArtifactCache';
import type { PassTrace } from './passPolicy';
import type { StageRequest, StageResult, StageStats, StagedFile } from './projectStager';

export interface CompileFrame {
  exit_code?: number;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log?: string;
}

export interface CompileFlowParams extends StageRequest {
  driver: string;
  endpoint: string;
}

/** A staged file as handed to the pipeline; `injected` marks a carried artifact. */
export type FlowFile = StagedFile & { injected?: boolean };

export interface CompileFlowDeps {
  stage(request: StageRequest): StageResult;
  run(files: FlowFile[], mainFile: string, timeoutMs: number): Promise<CompileFrame>;
  /** The pass trace of the run that just finished (undefined: upstream schedule). */
  takeTrace(): PassTrace | undefined;
  /** Artifacts left in the engine's FS by the run that just finished. */
  collectArtifacts(sourcePaths: ReadonlySet<string>): Promise<CachedArtifact[]>;
  /** Data packages the engine has mounted, for the next prewarm. */
  enabledPackages(): Promise<string[]>;
  cache: BuildArtifactCache;
  assetVersion: string;
  timeoutMs: number;
  caseInsensitive: boolean;
  now(): number;
}

export interface CompileFlowResult {
  frame: CompileFrame;
  trace?: PassTrace;
  stage: StageStats;
  /** Artifacts carried into the first attempt. */
  artifactsInjected: number;
  retriedCold: boolean;
  /** The run was clean and its artifacts were stored for the next compile. */
  stored: boolean;
}

export const COLD_RETRY_NOTE = '$ # retried without cached build artifacts';

interface Attempt {
  frame?: CompileFrame;
  error?: unknown;
  trace?: PassTrace;
}

type Fold = (path: string) => string;

function isClean(attempt: Attempt): boolean {
  if (!attempt.frame || attempt.frame.exit_code !== 0) return false;
  return !attempt.trace?.halted;
}

/** Folded paths a post-processor rewrote during the attempt. */
function regeneratedIn(attempt: Attempt, fold: Fold): Set<string> {
  return new Set((attempt.trace?.regenerated ?? []).map(fold));
}

/** Staged files plus carried artifacts; `replaced` lists staged paths an artifact took over. */
function injectArtifacts(
  staged: StagedFile[],
  carried: CachedArtifact[],
  fold: Fold
): { files: FlowFile[]; replaced: string[] } {
  const carriedKeys = new Set(carried.map((a) => fold(a.path)));
  const replaced = staged.map((f) => fold(f.path)).filter((p) => carriedKeys.has(p));
  return {
    files: [
      ...staged.filter((f) => !carriedKeys.has(fold(f.path))),
      ...carried.map((a) => ({ path: a.path, contents: a.bytes, injected: true })),
    ],
    replaced,
  };
}

interface RetryInputs {
  warm: Attempt;
  carried: number;
  replaced: string[];
  fold: Fold;
  /** Signature a cold run of this key last failed with; undefined: none recorded. */
  coldFailure(): string | null | undefined;
}

/** Whether the warm result may owe its outcome to the carried artifacts. */
function shouldRetryCold({ warm, carried, replaced, fold, coldFailure }: RetryInputs): boolean {
  if (carried === 0) return false;
  if (isClean(warm)) {
    // Clean, but a replaced file no tool rewrote was read as carried.
    const regenerated = regeneratedIn(warm, fold);
    return !replaced.every((path) => regenerated.has(path));
  }
  const remembered = coldFailure();
  return remembered === undefined || remembered !== (warm.trace?.firstError ?? null);
}

/** One engine run against a deadline shared by every attempt of the compile. */
async function runAttempt(
  deps: CompileFlowDeps,
  files: FlowFile[],
  mainFile: string,
  deadline: number
): Promise<Attempt> {
  try {
    const frame = await deps.run(files, mainFile, Math.max(deadline - deps.now(), 1));
    return { frame, trace: deps.takeTrace() };
  } catch (error) {
    return { error, trace: deps.takeTrace() };
  }
}

interface StoreRequest {
  key: string;
  root: string;
  run: Attempt;
  staged: StagedFile[];
  fold: Fold;
}

/** Keep a clean run's artifacts and the data packages it mounted. */
async function storeRun(deps: CompileFlowDeps, { key, root, run, staged, fold }: StoreRequest) {
  // A staged file a tool rewrote is this run's product, carried like any other.
  const regenerated = regeneratedIn(run, fold);
  const sources = staged.map((f) => f.path).filter((p) => !regenerated.has(fold(p)));
  deps.cache.put(key, await deps.collectArtifacts(new Set(sources)));
  deps.cache.recordPackages(root, await deps.enabledPackages());
}

export async function runCompileFlow(
  params: CompileFlowParams,
  deps: CompileFlowDeps
): Promise<CompileFlowResult> {
  const deadline = deps.now() + deps.timeoutMs;
  const staged = deps.stage(params);
  const fold: Fold = (p) => (deps.caseInsensitive ? p.toLowerCase() : p);
  const root = params.projectRoot ?? params.outputDir;
  const key = deps.cache.key({
    root,
    mainFile: staged.mainFile,
    driver: params.driver,
    assetVersion: deps.assetVersion,
    endpoint: params.endpoint,
  });
  const carried = deps.cache.get(key) ?? [];
  const warm = injectArtifacts(staged.files, carried, fold);

  let final = await runAttempt(deps, warm.files, staged.mainFile, deadline);
  const retriedCold =
    deps.now() < deadline &&
    shouldRetryCold({
      warm: final,
      carried: carried.length,
      replaced: warm.replaced,
      fold,
      coldFailure: () => deps.cache.coldFailure(key),
    });
  if (retriedCold) {
    final = await runAttempt(deps, staged.files, staged.mainFile, deadline);
    if (!isClean(final)) deps.cache.recordColdFailure(key, final.trace?.firstError ?? null);
  }

  if (final.error !== undefined) throw final.error;
  const frame = final.frame as CompileFrame;
  if (retriedCold) frame.log = `${COLD_RETRY_NOTE}\n${frame.log ?? ''}`;
  const stored = isClean(final);
  if (stored) await storeRun(deps, { key, root, run: final, staged: staged.files, fold });

  return {
    frame,
    trace: final.trace,
    stage: staged.stats,
    // Carried into the first attempt; `retriedCold` says whether they were dropped.
    artifactsInjected: carried.length,
    retriedCold,
    stored,
  };
}
