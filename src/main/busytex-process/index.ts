/**
 * @file busytex-process/index.ts — BusyTeX engine host (UtilityProcess entry)
 *
 * Runs the browser-targeted BusyTeX worker (busytex_worker.js →
 * busytex_pipeline.js → busytex.wasm) inside an Electron UtilityProcess so
 * the several-hundred-MB Emscripten heap lives in its own OS process instead
 * of the renderer. Renderer jank from heap growth and GC is structurally
 * gone, and the compiled PDF never crosses process boundaries — this process
 * writes the artifacts to disk itself and reports only paths.
 *
 * Wire protocol (mirrors LSPProcessClient's contract):
 *   request  { id, type: 'request', method, params }
 *   response { id, type: 'response', result?, error? }
 *   event    { type: 'event', event: 'print', data: { line } }
 *
 * Methods:
 *   load            — importScripts busytex_worker.js and run the init
 *                     handshake (instantiates the wasm and the preloaded data
 *                     packages, plus those `projectRoot` needed last time)
 *   compile         — stage the project from disk, run the pipeline with the
 *                     last clean run's artifacts (compileFlow.ts), write
 *                     {outputDir}/{baseName}.pdf / .synctex.gz / .log, return
 *                     { exitCode, pdfPath, synctexPath, log }
 *   clearBuildCache — drop the incremental artifacts, memory and disk
 *   release         — flush and exit(0) (used by the idle-memory release)
 *
 * Environment (injected by BusyTexProcessClient — utility processes cannot
 * call app.getPath()):
 *   WASM_ASSETS_DIR         on-disk dir holding busytex.js/.wasm,
 *                           texlive-*.js/.data, busytex_worker.js,
 *                           busytex_pipeline.js, manifest.json
 *   TEXLIVE_CACHE_DIR       disk cache shared with the main process (same
 *                           sha256-URL keying, so entries written by either
 *                           side are hits for both)
 *   BUSYTEX_BUILD_CACHE_DIR incremental build artifacts and the per-project
 *                           prewarm package list (buildArtifactCache.ts)
 *
 * The browser-worker-under-Node shims (fs path translation, synchronous XHR
 * for kpathsea's on-demand package fetches, importScripts, CommonJS globals)
 * come from the proven bench harness — scripts/bench/worker-shim.mjs — where
 * they were validated by the benchmark suite and the template verifier.
 */

import fs from 'node:fs';
import * as nodePath from 'node:path';
import { browserGlobals, installFsPathTranslation, installWorkerGlobals } from './browserShims';
import { BuildArtifactCache } from './buildArtifactCache';
import { type ArtifactFs, fingerprintArtifacts, listArtifacts } from './buildArtifacts';
import {
  type CompileFlowDeps,
  type CompileFlowParams,
  type CompileFlowResult,
  type CompileFrame,
  runCompileFlow,
} from './compileFlow';
import { resetStats } from './engineStats';
import { BUILD_CACHE_DIR, COMPILE_TIMEOUT_MS, LOAD_TIMEOUT_MS, WASM_ASSETS_DIR } from './env';
import { emitEvent, onParentClose, onParentMessage, sendToParent } from './hostChannel';
import { FINAL_FOR_ALL_PASSES, type PassTrace, installPassPolicy } from './passPolicy';
import { ProjectStager } from './projectStager';
import { installNetworkShims } from './remoteFetch';
import { installWorkerBridge, setPrintListener, workerCall } from './workerBridge';
import { CJK_PACKAGE_URL, needsCjkPackage } from './cjkPackages';

if (!WASM_ASSETS_DIR) {
  process.stderr.write('[busytex-process] WASM_ASSETS_DIR not set — cannot start\n');
  process.exit(1);
}

// ====== Browser shims (worker target → plain Node) ======

installWorkerGlobals();
installFsPathTranslation();
installNetworkShims();
installWorkerBridge();

// ====== Engine host ======

/** Set once the load handshake completes; compiles refuse before it. */
let pipelineReady = false;
/**
 * The one and only `load` attempt of this process's lifetime, kept cached
 * AFTER it settles too — including a rejection. `importScripts` declares
 * top-level classes as an irreversible side effect in this VM context, so
 * any second `load` message (client race, straggler after a failure) must
 * observe the cached outcome rather than re-run importScripts, which would
 * crash with "Identifier ... already been declared". On failure the process
 * also schedules its own exit so the client respawns fresh.
 */
let loadInFlight: Promise<{ loaded: true }> | null = null;

/**
 * Report the IO accounting for one call and open a fresh window. Emitted as an
 * event rather than folded into the response so the wire result types stay
 * unchanged — this is diagnostic data, not part of the compile contract.
 */
function reportStats(phase: 'load' | 'compile', timings: Record<string, unknown>): void {
  emitEvent('stats', { phase, ...timings, ...resetStats() });
}

/** Emscripten module surface touched by the host (filesystem, ENV, remote cache reset). */
interface PipelineModule {
  FS?: ArtifactFs & {
    unlink?: (path: string) => void;
  };
  data_packages_js?: unknown[];
  ENV?: Record<string, string>;
  kpse_remote_clear?: () => void;
}

/** The parts of the upstream pipeline instance (`self.pipeline`) the host reads. */
interface PipelineInstance {
  scipen_last_trace?: PassTrace;
  project_dir?: string;
  env?: Record<string, string>;
  Module?: Promise<PipelineModule | null> | null;
  reload_module_if_needed?: (
    cond: boolean,
    env: Record<string, string>,
    projectDir: string,
    dataPackagesJs: string[]
  ) => Promise<PipelineModule | null>;
}

function pipelineInstance(): PipelineInstance | undefined {
  return (globalThis as { pipeline?: PipelineInstance }).pipeline;
}

/** Take the pass trace the policy left behind, so it is reported exactly once. */
function takePassTrace(): PassTrace | undefined {
  const instance = pipelineInstance();
  const trace = instance?.scipen_last_trace;
  if (instance) instance.scipen_last_trace = undefined;
  return trace;
}

// ====== Request handlers ======

/**
 * Load the pipeline. busytex_worker.js imports busytex_pipeline.js itself;
 * the init frame then triggers fetching/instantiating busytex.wasm and the
 * preloaded TeX Live data packages (~120 MB, once per process lifetime).
 */
function handleLoad(params: { projectRoot?: string } = {}): Promise<{ loaded: true }> {
  if (pipelineReady) return Promise.resolve({ loaded: true });
  // Cached attempt — INCLUDING a rejection. `importScripts` declares
  // top-level classes as an irreversible side effect, so there is exactly
  // one load attempt per process lifetime, ever: a second `load` message
  // (client race, straggler after a failure) gets the cached outcome instead
  // of re-running importScripts and crashing on redeclared classes.
  if (loadInFlight) return loadInFlight;

  // Measured from before importScripts so the window covers the whole load,
  // including the ~120 MB of wasm + data packages read off disk.
  const loadT0 = performance.now();
  resetStats();

  loadInFlight = (async () => {
    setPrintListener((line) => emitEvent('print', { line }));

    // busytex_worker.js assigns `onmessage` at import time; workerPost
    // drives it. Runs exactly once per process lifetime — see loadInFlight.
    browserGlobals.importScripts('busytex_worker.js');

    // Before the init frame: the pass schedule is ours (see passPolicy.ts).
    // Without the class (a fixture worker) the seam keeps upstream's schedule.
    const policyInstalled = installPassPolicy(
      (globalThis as { BusytexPipeline?: unknown }).BusytexPipeline,
      { finalForAllPasses: FINAL_FOR_ALL_PASSES, fingerprint: fingerprintArtifacts }
    );
    if (!policyInstalled) {
      process.stderr.write(
        '[busytex-process] BusytexPipeline not found; upstream pass schedule in use\n'
      );
    }

    // The init frame makes the pipeline fetch + instantiate busytex.wasm
    // and mount the preloaded TeX Live data packages (~120 MB, once per
    // process). baseCatalogList excludes the CJK pack so non-CJK resolver
    // fallbacks stay isolated; CJK compiles mount catalogList explicitly.
    catalogList = manifestList('catalog');
    baseCatalogList = catalogList.filter((u) => u !== CJK_PACKAGE_URL);
    activeEndpoint = null;
    // Mount what this project needed last time in the same instantiation:
    // otherwise its first compile re-instantiates the module to add them
    // (~2.7 s for the 324 MB texlive-extra). Only catalog members are
    // accepted, and order matches upstream's enabled.concat(new).
    const warm = params.projectRoot
      ? buildCache.warmPackages(params.projectRoot).filter((p) => catalogList.includes(p))
      : [];
    const preloadPackages = [...manifestList('preload'), ...warm];
    await workerCall(
      {
        busytex_js: 'scipen-wasm://busytex/busytex.js',
        busytex_wasm: 'scipen-wasm://busytex/busytex.wasm',
        preload_data_packages_js: preloadPackages,
        data_packages_js: baseCatalogList,
        texmf_local: [],
        preload: true,
      },
      LOAD_TIMEOUT_MS
    );
    pipelineReady = true;
    reportStats('load', {
      totalMs: Math.round(performance.now() - loadT0),
      ok: true,
      dataPackages: preloadPackages,
    });
    return { loaded: true } as const;
  })().catch((err: unknown) => {
    // A failed load is exactly when the numbers matter most (a timeout is
    // usually starved fetches, not a broken engine) — report before exiting.
    reportStats('load', { totalMs: Math.round(performance.now() - loadT0), ok: false });
    // importScripts already ran — this process can never load again.
    // Self-terminate once the error response has a moment to flush over the
    // message port (mirrors `release`'s 50 ms grace); the client's exit
    // handler then forces the next attempt onto a fresh process.
    setTimeout(() => process.exit(1), 50);
    throw err;
  });
  return loadInFlight;
}

function manifestList(kind: 'preload' | 'catalog'): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(nodePath.join(WASM_ASSETS_DIR, 'manifest.json'), 'utf8')
  ) as { preload?: string[]; catalog?: string[] };
  return (manifest[kind] ?? []).map((n) => `scipen-wasm://busytex/${n}`);
}

/** Full catalog captured at load time (includes optional CJK pack). */
let catalogList: string[] = [];
/** Base catalog exposed to upstream's resolver fallback (excludes CJK pack). */
let baseCatalogList: string[] = [];
/** Guard serializing compile runs across async CJK mounting and worker calls. */
let compileInFlight = false;
/** Last TEXLIVE_REMOTE_ENDPOINT configured on the live Emscripten module. */
let activeEndpoint: string | null = null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function ensureCjkCatalogMounted(wantCjk: boolean, timeoutMs: number): Promise<void> {
  if (!wantCjk) return;
  const instance = pipelineInstance();
  if (!instance?.reload_module_if_needed || !instance.env || !instance.project_dir) {
    return;
  }
  try {
    const nextModule = instance.reload_module_if_needed(
      false,
      instance.env,
      instance.project_dir,
      catalogList
    );
    const mounted = await withTimeout(nextModule, timeoutMs, 'CJK data package mount');
    instance.Module = Promise.resolve(mounted);
  } catch (err) {
    pipelineReady = false;
    setTimeout(() => process.exit(1), 50);
    throw err;
  }
}

async function syncRemoteEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
  const modPromise = pipelineInstance()?.Module;
  const module = modPromise
    ? await withTimeout(Promise.resolve(modPromise), timeoutMs, 'module resolve')
    : null;
  if (!module) return;
  if (activeEndpoint !== null && activeEndpoint !== endpoint) {
    module.kpse_remote_clear?.();
    const fsApi = module.FS;
    if (fsApi?.analyzePath?.('/tmp/texlive_remote')?.exists && fsApi.readdir && fsApi.unlink) {
      try {
        for (const entry of fsApi.readdir('/tmp/texlive_remote')) {
          if (entry === '.' || entry === '..') continue;
          const full = `/tmp/texlive_remote/${entry}`;
          try {
            const st = fsApi.stat(full);
            if (!fsApi.isDir(st.mode)) {
              fsApi.unlink(full);
            }
          } catch {
            /* best effort per entry */
          }
        }
      } catch {
        /* best effort */
      }
    }
  }
  if (module.ENV) {
    module.ENV.TEXLIVE_REMOTE_ENDPOINT = endpoint;
  }
  activeEndpoint = endpoint;
}

function manifestVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(nodePath.join(WASM_ASSETS_DIR, 'manifest.json'), 'utf8')
    ) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Sources and figures are staged from disk here, next to the engine. */
const stager = new ProjectStager();
/** Last clean run's artifacts per (project, main file, driver), for incremental compiles. */
const buildCache = new BuildArtifactCache(BUILD_CACHE_DIR);

async function handleCompile(params: CompileFlowParams): Promise<{
  exitCode: number;
  pdfPath?: string;
  synctexPath?: string;
  log: string;
}> {
  if (!pipelineReady) {
    throw new Error('engine not loaded — call load first');
  }
  if (compileInFlight) {
    throw new Error('engine busy — another call is in flight');
  }
  compileInFlight = true;
  const totalT0 = performance.now();
  resetStats();
  let flow: CompileFlowResult | undefined;
  let workerMs = 0;
  let writeMs = 0;
  let pdfBytes = 0;
  takePassTrace();

  // `finally` so a failed or timed-out compile still reports: a compile that
  // blew the 600 s cap is precisely the case where the fetch counts explain
  // why, and losing them on the error path would defeat the instrumentation.
  try {
    const workerT0 = performance.now();
    flow = await runCompileFlow(params, compileFlowDeps(params));
    workerMs = performance.now() - workerT0;

    const { frame } = flow;
    const exitCode = frame.exit_code ?? -1;
    const log = frame.log ?? '';

    // Artifacts are written HERE, in this process — the PDF crosses no IPC
    // boundary; the renderer only ever sees paths.
    let pdfPath: string | undefined;
    let synctexPath: string | undefined;
    const writeT0 = performance.now();
    if (exitCode === 0 && frame.pdf && frame.pdf.byteLength > 0) {
      fs.mkdirSync(params.outputDir, { recursive: true });
      pdfPath = nodePath.join(params.outputDir, `${params.baseName}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from(frame.pdf));
      pdfBytes = frame.pdf.byteLength;
      if (frame.synctex && frame.synctex.byteLength > 0) {
        synctexPath = nodePath.join(params.outputDir, `${params.baseName}.synctex.gz`);
        fs.writeFileSync(synctexPath, Buffer.from(frame.synctex));
      }
    }
    writeCompileLog(params.outputDir, params.baseName, log);
    writeMs = performance.now() - writeT0;

    return { exitCode, pdfPath, synctexPath, log };
  } finally {
    compileInFlight = false;
    const trace = flow?.trace;
    reportStats('compile', {
      totalMs: Math.round(performance.now() - totalT0),
      workerMs: Math.round(workerMs),
      writeMs: Math.round(writeMs),
      pdfBytes,
      stage: flow?.stage,
      artifactsInjected: flow?.artifactsInjected,
      retriedCold: flow?.retriedCold,
      artifactsStored: flow?.stored,
      // Absent when the upstream schedule ran (policy not installed).
      passes: trace?.passes,
      texPasses: trace?.texPasses,
      converged: trace?.converged,
      halted: trace?.halted,
    });
  }
}

/** Bind the compile flow to this engine host's worker, pipeline and caches. */
function compileFlowDeps(params: CompileFlowParams): CompileFlowDeps {
  return {
    stage: (request) => stager.stage(request),
    run: async (files, mainFile, timeoutMs) => {
      const runDeadline = performance.now() + timeoutMs;
      const wantCjk = catalogList.includes(CJK_PACKAGE_URL) && needsCjkPackage(files);
      await ensureCjkCatalogMounted(wantCjk, timeoutMs);
      const beforeSyncRemaining = Math.max(1, Math.round(runDeadline - performance.now()));
      await syncRemoteEndpoint(params.endpoint, beforeSyncRemaining);
      const remainingMs = Math.round(runDeadline - performance.now());
      if (remainingMs <= 0) {
        throw new Error(`compile timed out after ${timeoutMs}ms before worker dispatch`);
      }
      return (await workerCall(
        {
          files,
          main_tex_path: mainFile,
          bibtex: null,
          makeindex: null,
          rerun: null,
          verbose: 'silent',
          driver: params.driver,
          // Always pass baseCatalogList: for CJK docs, full catalogList
          // (extra + cjk) is mounted via ensureCjkCatalogMounted above; for
          // non-CJK docs, this isolates texlive-cjk.js from resolver fallbacks.
          data_packages_js: baseCatalogList,
          remote_endpoint: params.endpoint,
        },
        remainingMs
      )) as CompileFrame;
    },
    takeTrace: takePassTrace,
    collectArtifacts: async (sources) => {
      // The project dir stays mounted until the next compile remounts it, so
      // the run that just finished can still be read back here.
      try {
        const instance = pipelineInstance();
        const module = await instance?.Module;
        if (!module?.FS || !instance?.project_dir) return [];
        return listArtifacts(module.FS, instance.project_dir, sources);
      } catch {
        return [];
      }
    },
    enabledPackages: async () => {
      try {
        const module = await pipelineInstance()?.Module;
        return (module?.data_packages_js ?? []).filter((p) => typeof p === 'string');
      } catch {
        return [];
      }
    },
    cache: buildCache,
    assetVersion: manifestVersion(),
    timeoutMs: COMPILE_TIMEOUT_MS,
    caseInsensitive: process.platform === 'win32',
    now: () => performance.now(),
  };
}

/**
 * Drop `{baseName}.log` next to the PDF, matching what a local TeX install
 * leaves behind — otherwise the WASM log lives only in memory and partial or
 * broken output cannot be diagnosed after the fact. Written on failure too:
 * that is exactly when the log is needed. Best-effort: a log that cannot be
 * written must never turn a successful compile into a failed one.
 */
function writeCompileLog(outputDir: string, baseName: string, log: string): void {
  if (!log) return;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(nodePath.join(outputDir, `${baseName}.log`), log, 'utf8');
  } catch {
    // Read-only project dir, AV lock, ... — the compile result stands.
  }
}

// ====== Dispatch ======

const METHODS = {
  load: (params: never) => handleLoad(params),
  compile: (params: never) => handleCompile(params),
  // Clears the in-memory copy too: deleting only the directory would leave a
  // running engine serving the artifacts it already holds.
  clearBuildCache: () => Promise.resolve(buildCache.clear()),
  health: () => Promise.resolve({ alive: true, pipelineReady }),
  // Idle-memory release: the response never arrives (the process exits
  // first) — the client treats the 3s timeout as the expected outcome.
  release: () => {
    pipelineReady = false;
    setTimeout(() => process.exit(0), 50);
    return Promise.resolve({ released: true });
  },
} as const;

onParentMessage((msg) => {
  if (msg?.type !== 'request') return;
  const id = String(msg.id);
  const method = String(msg.method) as keyof typeof METHODS;
  const handler = METHODS[method] as ((params: never) => Promise<unknown>) | undefined;
  if (!handler) {
    sendToParent({ type: 'response', id, error: { message: `Unknown method: ${method}` } });
    return;
  }
  handler((msg.params ?? {}) as never)
    .then((result) => sendToParent({ type: 'response', id, result }))
    .catch((err: unknown) =>
      sendToParent({
        type: 'response',
        id,
        error: { message: err instanceof Error ? err.message : String(err) },
      })
    );
});

onParentClose(() => process.exit(0));

// Announce readiness so the client can treat spawn success as a real signal.
sendToParent({ type: 'event', event: 'ready', data: null });
