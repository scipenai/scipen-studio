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
 *   load    — importScripts busytex_worker.js and run the init handshake
 *             (fetches + instantiates ~120 MB of wasm and data packages)
 *   compile — stage files, run the pipeline, write {outputDir}/{baseName}.pdf
 *             and .synctex.gz, return { exitCode, pdfPath, synctexPath, log }
 *   release — flush and exit(0) (used by the idle-memory release)
 *
 * Environment (injected by BusyTexProcessClient — utility processes cannot
 * call app.getPath()):
 *   WASM_ASSETS_DIR   on-disk dir holding busytex.js/.wasm, texlive-*.js/.data,
 *                     busytex_worker.js, busytex_pipeline.js, manifest.json
 *   TEXLIVE_CACHE_DIR disk cache shared with the main process (same sha256-URL
 *                     keying as the previous in-main proxy, so entries written
 *                     by either side are hits for both)
 *
 * The browser-worker-under-Node shims (fs path translation, synchronous XHR
 * for kpathsea's on-demand package fetches, importScripts, CommonJS globals)
 * come from the proven bench harness — scripts/bench/worker-shim.mjs — where
 * they were validated by the benchmark suite and the template verifier.
 */

import fs from 'node:fs';
import * as nodePath from 'node:path';
import { browserGlobals, installFsPathTranslation, installWorkerGlobals } from './browserShims';
import { resetStats } from './engineStats';
import { COMPILE_TIMEOUT_MS, LOAD_TIMEOUT_MS, WASM_ASSETS_DIR } from './env';
import { emitEvent, onParentClose, onParentMessage, sendToParent } from './hostChannel';
import { installNetworkShims } from './remoteFetch';
import { installWorkerBridge, setPrintListener, workerCall } from './workerBridge';

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
function reportStats(phase: 'load' | 'compile', timings: Record<string, number | boolean>): void {
  emitEvent('stats', { phase, ...timings, ...resetStats() });
}

// ====== Request handlers ======

/**
 * Load the pipeline. busytex_worker.js imports busytex_pipeline.js itself;
 * the init frame then triggers fetching/instantiating busytex.wasm and the
 * preloaded TeX Live data packages (~120 MB, once per process lifetime).
 */
function handleLoad(): Promise<{ loaded: true }> {
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

    // The init frame makes the pipeline fetch + instantiate busytex.wasm
    // and mount the preloaded TeX Live data packages (~120 MB, once per
    // process). The catalog list is kept for compiles: the package resolver
    // maps missing files (ctexart.cls, …) to remote data packages through
    // it — without it, every non-preloaded package fails "file not found".
    catalogList = manifestList('catalog');
    await workerCall(
      {
        busytex_js: 'scipen-wasm://busytex/busytex.js',
        busytex_wasm: 'scipen-wasm://busytex/busytex.wasm',
        preload_data_packages_js: manifestList('preload'),
        data_packages_js: catalogList,
        texmf_local: [],
        preload: true,
      },
      LOAD_TIMEOUT_MS
    );
    pipelineReady = true;
    reportStats('load', { totalMs: Math.round(performance.now() - loadT0), ok: true });
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

/** Catalog captured at load time; every compile passes it to the resolver. */
let catalogList: string[] = [];

async function handleCompile(params: {
  files: Array<{ path: string; contents: string; encoding?: 'utf8' | 'base64' }>;
  mainFile: string;
  driver: string;
  endpoint: string;
  outputDir: string;
  baseName: string;
}): Promise<{
  exitCode: number;
  pdfPath?: string;
  synctexPath?: string;
  log: string;
}> {
  if (!pipelineReady) {
    throw new Error('engine not loaded — call load first');
  }
  const totalT0 = performance.now();
  resetStats();
  let decodeMs = 0;
  let workerMs = 0;
  let writeMs = 0;
  let pdfBytes = 0;

  // `finally` so a failed or timed-out compile still reports: a compile that
  // blew the 600 s cap is precisely the case where the fetch counts explain
  // why, and losing them on the error path would defeat the instrumentation.
  try {
    // base64 entries are BINARY staged files (figures): decode to bytes here so
    // the pipeline's FS.writeFile receives real bytes — emscripten accepts
    // Uint8Array/Buffer natively, and xdvipdfmx embeds them untouched. Text
    // entries stay strings.
    const decodeT0 = performance.now();
    const stagedFiles = params.files.map((f) => ({
      path: f.path,
      contents: f.encoding === 'base64' ? Buffer.from(f.contents, 'base64') : f.contents,
    }));
    decodeMs = performance.now() - decodeT0;

    const workerT0 = performance.now();
    const frame = await workerCall(
      {
        files: stagedFiles,
        main_tex_path: params.mainFile,
        bibtex: null,
        makeindex: null,
        rerun: null,
        verbose: 'silent',
        driver: params.driver,
        // The package resolver maps missing files to remote data packages via
        // this catalog — an empty list makes every non-preloaded package
        // (ctex, …) fail with "file not found".
        data_packages_js: catalogList,
        remote_endpoint: params.endpoint,
      },
      COMPILE_TIMEOUT_MS
    );
    workerMs = performance.now() - workerT0;

    const exitCode = (frame.exit_code as number | undefined) ?? -1;
    const pdf = frame.pdf as Uint8Array | undefined;
    const synctex = frame.synctex as Uint8Array | undefined;
    const log = (frame.log as string) ?? '';

    // Artifacts are written HERE, in this process — the PDF crosses no IPC
    // boundary; the renderer only ever sees paths.
    let pdfPath: string | undefined;
    let synctexPath: string | undefined;
    const writeT0 = performance.now();
    if (exitCode === 0 && pdf && pdf.byteLength > 0) {
      fs.mkdirSync(params.outputDir, { recursive: true });
      pdfPath = nodePath.join(params.outputDir, `${params.baseName}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from(pdf));
      pdfBytes = pdf.byteLength;
      if (synctex && synctex.byteLength > 0) {
        synctexPath = nodePath.join(params.outputDir, `${params.baseName}.synctex.gz`);
        fs.writeFileSync(synctexPath, Buffer.from(synctex));
      }
    }
    writeCompileLog(params.outputDir, params.baseName, log);
    writeMs = performance.now() - writeT0;

    return { exitCode, pdfPath, synctexPath, log };
  } finally {
    reportStats('compile', {
      totalMs: Math.round(performance.now() - totalT0),
      decodeMs: Math.round(decodeMs),
      workerMs: Math.round(workerMs),
      writeMs: Math.round(writeMs),
      stagedFiles: params.files.length,
      pdfBytes,
    });
  }
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
  load: () => handleLoad(),
  compile: (params: never) => handleCompile(params),
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
