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

import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import * as nodePath from 'node:path';
import vm from 'node:vm';
import type { MessagePortMain } from 'electron';

// ====== Environment ======

// Type declaration: Electron UtilityProcess parentPort (same as lsp-process).
declare const process: NodeJS.Process & {
  parentPort: {
    postMessage(message: unknown): void;
    on(
      event: 'message',
      listener: (messageEvent: { data: unknown; ports: MessagePortMain[] }) => void
    ): void;
    on(event: 'close', listener: () => void): void;
  };
};

const WASM_ASSETS_DIR = process.env.WASM_ASSETS_DIR ?? '';
const TEXLIVE_CACHE_DIR = process.env.TEXLIVE_CACHE_DIR ?? '';
const SCHEME = 'scipen-wasm://busytex/';
/** Ceiling for one synchronous remote fetch; kpse probes must not hang. */
const SYNC_FETCH_TIMEOUT_S = 60;
/** Hard ceiling for the whole init handshake (wasm + data packages). */
const LOAD_TIMEOUT_MS = 300_000;
/** Hard ceiling for one compile (matches the previous renderer-side limit). */
const COMPILE_TIMEOUT_MS = 600_000;

if (!WASM_ASSETS_DIR) {
  process.stderr.write('[busytex-process] WASM_ASSETS_DIR not set — cannot start\n');
  process.exit(1);
}

// ====== Browser shims (worker target → plain Node) ======

/** The browser globals this process installs for the vendored worker code. */
const browserGlobals = globalThis as unknown as {
  self: unknown;
  postMessage: (msg: Record<string, unknown>) => void;
  require: NodeRequire;
  __dirname: string;
  __filename: string;
  XMLHttpRequest: unknown;
  fetch: typeof fetch;
  importScripts: (...srcs: string[]) => void;
  onmessage?: (ev: { data: unknown }) => void;
};

browserGlobals.self = globalThis;

function resolveAssetPath(url: string): string | null {
  if (url.startsWith(SCHEME)) {
    return nodePath.join(WASM_ASSETS_DIR, url.slice(SCHEME.length).split('?')[0]);
  }
  if (!/^[a-z]+:\/\//i.test(url)) {
    // Relative name (e.g. importScripts('busytex_worker.js')).
    return nodePath.join(WASM_ASSETS_DIR, url);
  }
  return null;
}

/**
 * The emscripten glue's Node branch reads data packages with plain
 * fs.readFileSync(urlString). Translate scheme URLs to on-disk paths — the
 * same job the app's `scipen-wasm://` protocol handler does for the browser
 * worker's fetch/XHR.
 */
function toDiskPath(p: unknown): unknown {
  if (typeof p === 'string' && p.startsWith(SCHEME)) {
    return nodePath.join(WASM_ASSETS_DIR, p.slice(SCHEME.length).split('?')[0]);
  }
  return p;
}

const fsPatched = fs as unknown as Record<string, unknown>;
for (const name of [
  'readFileSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'openSync',
  'realpathSync',
  'accessSync',
  'readFile',
  'stat',
  'open',
  'access',
]) {
  const original = fsPatched[name];
  if (typeof original !== 'function') continue;
  fsPatched[name] = function patched(this: unknown, p: unknown, ...rest: unknown[]) {
    return (original as (...a: unknown[]) => unknown).call(this, toDiskPath(p), ...rest);
  };
}

/** Synchronous cache lookup mirroring TexliveRemoteCache's on-disk layout. */
function cacheLookup(url: string): { status: 200 | 404; body: Buffer } | null {
  if (!TEXLIVE_CACHE_DIR) return null;
  const key = crypto.createHash('sha256').update(url).digest('hex');
  const missPath = nodePath.join(TEXLIVE_CACHE_DIR, `${key}.miss`);
  const contentPath = nodePath.join(TEXLIVE_CACHE_DIR, `${key}.bin`);
  try {
    if (fs.existsSync(missPath)) {
      // Same 7-day TTL as TexliveRemoteCache.MISS_TTL_MS.
      if (Date.now() - fs.statSync(missPath).mtimeMs > 7 * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(missPath);
        return null;
      }
      return { status: 404, body: Buffer.alloc(0) };
    }
    if (!fs.existsSync(contentPath)) return null;
    return { status: 200, body: fs.readFileSync(contentPath) };
  } catch {
    return null;
  }
}

/** Synchronous cache store (atomic rename — safe alongside the main process). */
function cacheStore(url: string, body: Buffer, isMiss: boolean): void {
  if (!TEXLIVE_CACHE_DIR) return;
  try {
    fs.mkdirSync(TEXLIVE_CACHE_DIR, { recursive: true });
    const key = crypto.createHash('sha256').update(url).digest('hex');
    const dest = nodePath.join(TEXLIVE_CACHE_DIR, isMiss ? `${key}.miss` : `${key}.bin`);
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
  } catch {
    // Cache writes must never break a compile.
  }
}

class XMLHttpRequestShim {
  status = 0;
  response: ArrayBuffer | string = '';
  responseText = '';
  responseType = '';
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  private method = 'GET';
  private url = '';

  open(method: string, url: string): void {
    this.method = method.toUpperCase();
    this.url = url;
  }

  setRequestHeader(): void {
    /* kpse sends no meaningful headers */
  }

  overrideMimeType(): void {
    /* binary-safe by construction */
  }

  getResponseHeader(): string | null {
    return null;
  }

  send(): void {
    try {
      const disk = resolveAssetPath(this.url);
      if (disk) {
        this.status = 200;
        this.finish(fs.readFileSync(disk));
        return;
      }

      // Remote fetch (kpathsea on-demand packages). Cache first — hits cost
      // zero network and are shared with the main process. On miss, curl is
      // the only synchronous HTTP primitive usable inside a wasm call across
      // all three platforms; it also honours HTTPS_PROXY env vars.
      if (/^https?:\/\//i.test(this.url)) {
        const hit = cacheLookup(this.url);
        if (hit) {
          this.status = hit.status;
          this.finish(hit.body);
          return;
        }
        // curl does not create parent directories — a missing cache dir would
        // fail every remote fetch with a confusing curl exit code.
        try {
          fs.mkdirSync(TEXLIVE_CACHE_DIR || WASM_ASSETS_DIR, { recursive: true });
        } catch {
          /* best effort */
        }
        const tmp = nodePath.join(
          TEXLIVE_CACHE_DIR || WASM_ASSETS_DIR,
          `.fetch-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
        );
        const res = childProcess.spawnSync(
          'curl',
          [
            '-s',
            '-o',
            tmp,
            '-w',
            '%{http_code}',
            '-X',
            this.method,
            '--max-time',
            String(this.timeout > 0 ? Math.ceil(this.timeout / 1000) : SYNC_FETCH_TIMEOUT_S),
            this.url,
          ],
          { encoding: 'utf8' }
        );
        if (res.status !== 0) {
          this.status = 0;
          this.onerror?.(new Error(res.stderr || 'curl failed'));
          return;
        }
        this.status = Number(res.stdout) || 0;
        const body =
          this.status > 0 && this.status !== 404 && fs.existsSync(tmp)
            ? fs.readFileSync(tmp)
            : Buffer.alloc(0);
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        if (this.status === 200) cacheStore(this.url, body, false);
        else if (this.status === 404) cacheStore(this.url, Buffer.alloc(0), true);
        this.finish(body);
        return;
      }

      this.status = 0;
      this.onerror?.(new Error(`Unsupported URL: ${this.url}`));
    } catch (err) {
      this.status = 0;
      this.onerror?.(err);
    }
  }

  private finish(body: Buffer): void {
    if (this.responseType === 'arraybuffer') {
      this.response = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength
      ) as ArrayBuffer;
      this.responseText = '';
    } else {
      this.response = body.toString('utf8');
      this.responseText = body.toString('utf8');
    }
    this.onload?.();
  }
}

browserGlobals.XMLHttpRequest = XMLHttpRequestShim;

/**
 * Async curl with the shared disk cache — the fetch shim's remote path.
 * The pipeline fetches data packages over the network at runtime too (not
 * just kpse's sync XHR), so fetch needs the same cache/curl treatment as
 * XMLHttpRequest, just in async form.
 */
function curlFetch(
  method: string,
  url: string,
  timeoutS: number
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve) => {
    const hit = cacheLookup(url);
    if (hit) {
      resolve({ status: hit.status, body: hit.body });
      return;
    }
    try {
      fs.mkdirSync(TEXLIVE_CACHE_DIR || WASM_ASSETS_DIR, { recursive: true });
    } catch {
      /* best effort */
    }
    const tmp = nodePath.join(
      TEXLIVE_CACHE_DIR || WASM_ASSETS_DIR,
      `.fetch-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    childProcess.execFile(
      'curl',
      ['-s', '-o', tmp, '-w', '%{http_code}', '-X', method, '--max-time', String(timeoutS), url],
      { encoding: 'utf8', timeout: (timeoutS + 5) * 1000 },
      (err, stdout) => {
        const rawStatus = err ? 0 : Number(stdout) || 0;
        let body = Buffer.alloc(0);
        if (rawStatus === 200 && fs.existsSync(tmp)) {
          try {
            body = fs.readFileSync(tmp);
          } catch {
            body = Buffer.alloc(0);
          }
        }
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        if (rawStatus === 200) cacheStore(url, body, false);
        else if (rawStatus === 404) cacheStore(url, Buffer.alloc(0), true);
        resolve({ status: rawStatus >= 100 ? rawStatus : 502, body });
      }
    );
  });
}

/**
 * fetch shim — the pipeline loads busytex.wasm and every data package with
 * `fetch()` (busytex_pipeline.js lines 42/58/284), and an unshimmed fetch
 * here is catastrophic in the worst possible way: Node's fetch rejects on
 * the scipen-wasm:// scheme, the pipeline's init chain swallows the
 * rejection without ever posting `initialized` or an exception, and the
 * load handshake hangs until timeout. Mirrors the bench-validated shim:
 * scheme/relative URLs read from disk; http(s) goes through curl with the
 * shared TeX Live cache.
 */
function contentTypeFor(file: string): string {
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function fetchShim(url: URL | string, init?: { method?: string }): Promise<Response> {
  const urlStr = String(url);
  const disk = resolveAssetPath(urlStr);
  if (disk) {
    // Content-Type matters: WebAssembly.compileStreaming rejects any
    // response whose MIME type is not application/wasm.
    return new Response(fs.readFileSync(disk), {
      status: 200,
      headers: { 'Content-Type': contentTypeFor(disk) },
    });
  }
  if (/^https?:\/\//i.test(urlStr)) {
    const { status, body } = await curlFetch(
      (init?.method ?? 'GET').toUpperCase(),
      urlStr,
      SYNC_FETCH_TIMEOUT_S
    );
    return new Response(body, { status });
  }
  throw new TypeError(`fetch: unsupported url ${urlStr}`);
}

browserGlobals.fetch = fetchShim as unknown as typeof fetch;

// Safety net: the pipeline's init chain stores floating promises with no
// catch (e.g. on_initialized_promise.then(on_initialized)), so a rejected
// internal step NEVER reaches the worker's try/catch — it used to hang the
// load handshake silently until timeout. Route unhandled rejections into
// the pending call as a terminal exception frame instead.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[busytex-process] unhandled rejection:', message);
  if (pendingFrame) {
    const settle = pendingFrame;
    pendingFrame = null;
    settle({ exception: message });
  }
});

browserGlobals.importScripts = (...srcs: string[]): void => {
  for (const src of srcs) {
    const file = resolveAssetPath(src);
    if (!file) throw new Error(`importScripts: unsupported url ${src}`);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
};

// The emscripten glue detects Node and takes its CommonJS branch; give it the
// globals it expects, with relative lookups anchored inside the assets dir.
// In the bundled CJS output `require` exists in module scope.
browserGlobals.require = require;
browserGlobals.__dirname = WASM_ASSETS_DIR;
browserGlobals.__filename = nodePath.join(WASM_ASSETS_DIR, 'busytex.js');

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
 * Route a frame emitted by the worker. `print` frames stream out as events;
 * the first terminal frame (initialized / exception / compile result) settles
 * the pending call.
 */
let printListener: ((line: string) => void) | null = null;
let pendingFrame: ((frame: Record<string, unknown>) => void) | null = null;

/** Post a message to the main process (the utility's only outbound channel). */
function sendToParent(msg: Record<string, unknown>): void {
  process.parentPort?.postMessage(msg);
}

/** Unsolicited event stream (prints, phases) — not tied to a request id. */
function emitEvent(event: string, data: Record<string, unknown>): void {
  sendToParent({ type: 'event', event, data });
}

function onWorkerFrame(frame: Record<string, unknown>): void {
  if (frame.print !== undefined) {
    printListener?.(String(frame.print));
    return;
  }
  if (
    frame.exception !== undefined ||
    frame.initialized !== undefined ||
    frame.exit_code !== undefined ||
    frame.pdf !== undefined
  ) {
    const settle = pendingFrame;
    pendingFrame = null;
    settle?.(frame);
  }
}

// The worker script posts every frame through `postMessage`; route them into
// the host (prints → events, terminal frames → pending call).
browserGlobals.postMessage = (msg: Record<string, unknown>): void => {
  onWorkerFrame(msg);
};

/** The worker script installs `onmessage` at import time; drive it here. */
function workerPost(frame: Record<string, unknown>): void {
  void Promise.resolve(browserGlobals.onmessage?.({ data: frame })).catch((err: unknown) => {
    // Surface async exceptions from the worker's handler as a terminal frame
    // so a pending call cannot hang past the failure.
    pendingFrame?.({ exception: err instanceof Error ? err.stack : String(err) });
    pendingFrame = null;
  });
}

/** Send a frame into the worker and wait for its terminal reply. */
function workerCall(
  frame: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // The worker script has a single pending-call slot: a second concurrent
    // call would clobber pendingFrame — the first caller would hang to its
    // timeout and print/phase attribution would cross between the two. The
    // renderer serializes compiles, but the wire defends itself regardless.
    if (pendingFrame) {
      reject(new Error('engine busy — another call is in flight'));
      return;
    }
    const timer = setTimeout(() => {
      pendingFrame = null;
      reject(new Error(`engine call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingFrame = (settled) => {
      clearTimeout(timer);
      if (settled.exception) {
        reject(new Error(String(settled.exception)));
        return;
      }
      resolve(settled);
    };
    workerPost(frame);
  });
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

  loadInFlight = (async () => {
    printListener = (line) => emitEvent('print', { line });

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
    return { loaded: true } as const;
  })().catch((err: unknown) => {
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
  // base64 entries are BINARY staged files (figures): decode to bytes here so
  // the pipeline's FS.writeFile receives real bytes — emscripten accepts
  // Uint8Array/Buffer natively, and xdvipdfmx embeds them untouched. Text
  // entries stay strings.
  const stagedFiles = params.files.map((f) => ({
    path: f.path,
    contents: f.encoding === 'base64' ? Buffer.from(f.contents, 'base64') : f.contents,
  }));
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

  const exitCode = (frame.exit_code as number | undefined) ?? -1;
  const pdf = frame.pdf as Uint8Array | undefined;
  const synctex = frame.synctex as Uint8Array | undefined;

  // Artifacts are written HERE, in this process — the PDF crosses no IPC
  // boundary; the renderer only ever sees paths.
  let pdfPath: string | undefined;
  let synctexPath: string | undefined;
  if (exitCode === 0 && pdf && pdf.byteLength > 0) {
    fs.mkdirSync(params.outputDir, { recursive: true });
    pdfPath = nodePath.join(params.outputDir, `${params.baseName}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(pdf));
    if (synctex && synctex.byteLength > 0) {
      synctexPath = nodePath.join(params.outputDir, `${params.baseName}.synctex.gz`);
      fs.writeFileSync(synctexPath, Buffer.from(synctex));
    }
  }

  return { exitCode, pdfPath, synctexPath, log: (frame.log as string) ?? '' };
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

process.parentPort?.on('message', (event: { data: Record<string, unknown> }) => {
  const msg = event.data;
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

process.parentPort?.on('close', () => process.exit(0));

// Announce readiness so the client can treat spawn success as a real signal.
sendToParent({ type: 'event', event: 'ready', data: null });
