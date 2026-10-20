/**
 * @file busytex-process/compileFlow.ts — one compile, end to end
 *
 * stage → inject the last clean run's artifacts → compile → keep artifacts
 * only from a clean run → retry cold when injected artifacts may be to blame.
 *
 * Effects are injected so the rules below are testable without an engine:
 *
 *   - Artifacts never replace a staged file. Disk and the editor buffer are
 *     the truth; an artifact only fills a path nothing else provides.
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

function isClean(attempt: Attempt): boolean {
  if (!attempt.frame || attempt.frame.exit_code !== 0) return false;
  return !attempt.trace?.halted;
}

export async function runCompileFlow(
  params: CompileFlowParams,
  deps: CompileFlowDeps
): Promise<CompileFlowResult> {
  const started = deps.now();
  const staged = deps.stage(params);
  const fold = (p: string) => (deps.caseInsensitive ? p.toLowerCase() : p);
  const key = deps.cache.key({
    root: params.projectRoot ?? params.outputDir,
    mainFile: staged.mainFile,
    driver: params.driver,
    assetVersion: deps.assetVersion,
    endpoint: params.endpoint,
  });

  const stagedKeys = new Set(staged.files.map((f) => fold(f.path)));
  const carried = (deps.cache.get(key) ?? []).filter((a) => !stagedKeys.has(fold(a.path)));
  const warmFiles: FlowFile[] = [
    ...staged.files,
    ...carried.map((a) => ({ path: a.path, contents: a.bytes, injected: true })),
  ];

  const attempt = async (files: FlowFile[]): Promise<Attempt> => {
    const remaining = deps.timeoutMs - (deps.now() - started);
    try {
      const frame = await deps.run(files, staged.mainFile, Math.max(remaining, 1));
      return { frame, trace: deps.takeTrace() };
    } catch (error) {
      return { error, trace: deps.takeTrace() };
    }
  };

  let final = await attempt(warmFiles);
  let retriedCold = false;
  if (!isClean(final) && carried.length > 0) {
    const signature = final.trace?.firstError ?? null;
    const remembered = deps.cache.coldFailure(key);
    const knownGenuine = remembered !== undefined && remembered === signature;
    const timeLeft = deps.timeoutMs - (deps.now() - started) > 0;
    if (!knownGenuine && timeLeft) {
      final = await attempt(staged.files);
      retriedCold = true;
      if (!isClean(final)) deps.cache.recordColdFailure(key, final.trace?.firstError ?? null);
    }
  }

  if (final.error !== undefined) throw final.error;
  const frame = final.frame as CompileFrame;
  if (retriedCold) frame.log = `${COLD_RETRY_NOTE}\n${frame.log ?? ''}`;

  let stored = false;
  if (isClean(final)) {
    const sources = new Set(staged.files.map((f) => f.path));
    deps.cache.put(key, await deps.collectArtifacts(sources));
    deps.cache.recordPackages(params.projectRoot ?? params.outputDir, await deps.enabledPackages());
    stored = true;
  }

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
