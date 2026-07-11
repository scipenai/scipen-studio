/**
 * @file BusyTexEngine.ts - BusyTeX WASM Engine Wrapper
 * @description Adapts the BusyTeX Web Worker message protocol to a
 *              Promise-based API. Engines run entirely in the renderer
 *              process via Web Workers.
 * @depends BusyTeX WASM artifacts under public/wasm/busytex/
 *
 * Why a renderer-level adapter rather than re-using texlyre-busytex's
 * BusyTexRunner package?
 * - That package bundles its own Worker-loading flow and assumes
 *   browser-only path resolution; Electron renderer needs both
 *   `file://` and `http://` to work.
 * - Eliminating the npm dependency keeps the build deterministic — the
 *   WASM artifacts are the only versioned surface.
 *
 * Worker message protocol (texlyre-busytex-build/web/busytex_worker.js):
 *   initialize: {busytex_js, busytex_wasm, preload_data_packages_js,
 *                data_packages_js, texmf_local, preload}
 *               → {initialized: applet_versions} OR {exception}
 *   compile:    {files, main_tex_path, bibtex, makeindex, rerun,
 *                verbose, driver, data_packages_js, remote_endpoint}
 *               → {pdf, synctex, log, exit_code, logs} OR {exception}
 *   log line:   {print: msg}
 */

import { createLogger } from './LogService';

const logger = createLogger('BusyTexEngine');

/** Studio-facing engine identifier (mirrors public WasmEngine type). */
export type BusyTexEngineType = 'pdftex' | 'xetex' | 'lualatex';

/**
 * BusyTeX driver names live inside the WASM pipeline; the mapping is
 * fixed by the upstream `busytex_pipeline.js`. See lines 558-564 of
 * `texlyre-busytex-build/web/busytex_pipeline.js`.
 */
const DRIVER_MAP: Record<BusyTexEngineType, string> = {
  pdftex: 'pdftex_bibtex8',
  xetex: 'xetex_bibtex8_dvipdfmx',
  lualatex: 'luahbtex_bibtex8',
};

/**
 * The base URL where busytex **runtime assets** live (everything the worker
 * loads via `importScripts` or `fetch`: pipeline, wasm, texlive data packages).
 *
 * We route these through the `scipen-wasm://` custom protocol (registered in
 * `src/main/services/WasmAssetProtocol.ts`) because:
 *   - In packaged Electron, the renderer loads from `file://.../app.asar/...`.
 *     Chromium **blocks `fetch()` on the file: scheme** for security, and
 *     BusyTeX's `busytex_pipeline.js` calls `fetch()` on every `texlive-*.js`
 *     descriptor — under `file://` this throws `TypeError: Failed to fetch`
 *     and the pipeline never initializes.
 *   - `scipen-wasm://` is registered with `supportFetchAPI: true` and
 *     `corsEnabled: true`, plus the handler sets `Access-Control-Allow-Origin: *`,
 *     so cross-origin fetch from the file:// worker is permitted.
 *
 * IMPORTANT: the worker **script itself** is NOT loaded from here — see
 * {@link resolveWorkerUrl} for why.
 */
const BUSYTEX_BASE_URL = 'scipen-wasm://busytex';
const BUSYTEX_WORKER_FILE = 'busytex_worker.js';
const BUSYTEX_JS_FILE = 'busytex.js';
const BUSYTEX_WASM_FILE = 'busytex.wasm';

/**
 * The TeX Live package layout, written by `scripts/download-busytex-wasm.js`
 * and read at engine init (see {@link loadManifest}). It is the single source
 * of truth shared by the downloader and this engine — hard-coding the lists
 * here would drift from what the downloader actually fetched.
 *
 *   - preload: eagerly loaded into the WASM FS at init
 *   - catalog: importScripts()'d on demand by `busytex_pipeline.js`
 *
 * The manifest is a build-time artifact and MUST be present. A missing or
 * malformed manifest is a packaging error, not a runtime condition to paper
 * over — {@link loadManifest} throws rather than silently degrading.
 */
interface BusyTexManifest {
  version: string;
  mode: 'minimal' | 'full';
  preload: string[];
  catalog: string[];
}

/**
 * File staged into the WASM filesystem before compilation. Path is
 * project-relative (e.g. `main.tex`, `figures/diag.tex`).
 */
interface StagedFile {
  path: string;
  contents: string | Uint8Array;
}

/**
 * Per-compile knobs. The engine itself is engine-agnostic — same
 * `busytex.wasm` (combined build) serves all three drivers, so the
 * Studio-facing engine name is a compile-time choice, not a worker
 * lifecycle property. `verbose` defaults to 'silent' because BusyTeX's
 * 'info' opens Kpathsea debug which doubles compile time on font-heavy
 * documents (XeLaTeX especially); enable only when diagnosing.
 */
export interface CompileOptions {
  engineType: BusyTexEngineType;
  verbose?: 'silent' | 'info' | 'debug';
}

/**
 * Signals scraped from BusyTeX's log to make catalog/preload behavior
 * visible without patching the upstream pipeline. We grep the log for
 * fixed phrases the pipeline emits at line 531-534 of
 * `busytex_pipeline.js`. Surfaced via logger.info on every compile so a
 * future tuning decision (e.g. should catalog default to empty?) can be
 * grounded in field data rather than guesswork.
 */
interface BusyTexSignals {
  /** Whether BusyTeX flagged any package as not resolved by local/preload/catalog. */
  hasUnresolved: boolean;
  /** Catalog packages BusyTeX actually `load_package()`'d during this compile. */
  catalogPackagesUsed: string[];
}

export interface CompileOutput {
  success: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  status: number;
}

interface InitMessage {
  initialized?: unknown;
  exception?: string;
}

interface CompileMessage {
  pdf?: Uint8Array | ArrayBuffer;
  synctex?: Uint8Array | ArrayBuffer;
  log?: string;
  exit_code?: number;
  // Worker streams runtime logs as `{print: msg}` rather than tagged.
  print?: string;
  exception?: string;
}

/** Thrown when `close()` aborts an in-flight load/compile (user cancel). Lets
 *  callers distinguish an intentional stop from a real failure. */
export class BusyTexCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyTexCancelledError';
  }
}

/**
 * Wraps the BusyTeX Web Worker.
 *
 * Single worker for the lifetime of the provider — `busytex.wasm` is a
 * combined build that ships all three drivers (pdftex/xetex/lualatex);
 * switching engines means changing the `driver` field of the compile
 * payload, not respawning the worker (which would re-download 31 MB
 * wasm + re-mount 87 MB texlive-basic.data). The previous
 * `currentEngineType` re-init path was dead code; deleted.
 *
 * `writeFile` calls are batched into an in-memory file list and shipped
 * in a single `compile` message — BusyTeX's pipeline expects the full
 * source tree up front rather than incremental filesystem writes.
 */
export class BusyTexEngine {
  private worker: Worker | null = null;
  private _ready = false;
  private mainFile = 'main.tex';
  private files: StagedFile[] = [];
  private remoteEndpoint: string | undefined;
  // Rejects the in-flight async op — either a `loadEngine()` cold start or a
  // `compile()`. `close()` calls it so a user cancel settles that promise
  // immediately instead of hanging until the 5-minute timeout (terminating the
  // worker fires no message/error). load and compile never overlap, so one
  // slot suffices.
  private abortPending: (() => void) | null = null;

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Spawn the Worker and wait for the BusyTeX pipeline to initialize.
   * Wraps the upstream `{busytex_js, busytex_wasm, preload_data_packages_js, ...}`
   * handshake.
   */
  async loadEngine(): Promise<void> {
    if (this._ready && this.worker) return;

    const t0 = performance.now();
    const manifest = await loadManifest();

    const workerUrl = resolveWorkerUrl(BUSYTEX_WORKER_FILE);
    const busytexJs = resolveAssetUrl(BUSYTEX_JS_FILE);
    const busytexWasm = resolveAssetUrl(BUSYTEX_WASM_FILE);
    const preloadJsUrls = manifest.preload.map(resolveAssetUrl);
    const catalogJsUrls = manifest.catalog.map(resolveAssetUrl);

    logger.info('Loading BusyTeX worker', {
      url: workerUrl,
      preload: manifest.preload,
      catalog: manifest.catalog,
    });

    return new Promise<void>((resolve, reject) => {
      // Cold start downloads ~100MB of texlive-basic.data over a slow
      // connection. 5 minutes is the upper bound for first-run users.
      const timeout = setTimeout(
        () => reject(new Error('BusyTeX engine load timeout (5 minutes)')),
        300_000
      );

      try {
        this.worker = new Worker(workerUrl);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to create BusyTeX worker: ${err}`));
        return;
      }

      const initHandler = (ev: MessageEvent<InitMessage>) => {
        const data = ev.data;
        if (data.exception) {
          clearTimeout(timeout);
          this.abortPending = null;
          this.worker?.removeEventListener('message', initHandler);
          reject(new Error(`BusyTeX init failed: ${data.exception}`));
          return;
        }
        if (data.initialized) {
          clearTimeout(timeout);
          this.abortPending = null;
          this._ready = true;
          this.worker!.removeEventListener('message', initHandler);
          this.worker!.addEventListener('message', this.handleMessage.bind(this));
          logger.info('BusyTeX engine ready', {
            loadMs: Math.round(performance.now() - t0),
          });
          resolve();
        }
      };

      this.worker.addEventListener('message', initHandler);
      this.worker.addEventListener('error', (err: ErrorEvent) => {
        clearTimeout(timeout);
        this.abortPending = null;
        const detail = {
          message: err.message,
          filename: err.filename,
          lineno: err.lineno,
          colno: err.colno,
          url: workerUrl,
        };
        logger.error('BusyTeX worker error', detail);
        reject(new Error(`BusyTeX worker failed to load: ${err.message || 'Unknown error'}`));
      });

      // Let close()/cancel abort a cold start too — otherwise a stop during
      // the (potentially minutes-long) first load hangs until the timeout.
      this.abortPending = () => {
        clearTimeout(timeout);
        this.worker?.removeEventListener('message', initHandler);
        this.abortPending = null;
        reject(new BusyTexCancelledError('BusyTeX engine load cancelled'));
      };

      this.worker.postMessage({
        busytex_js: busytexJs,
        busytex_wasm: busytexWasm,
        preload_data_packages_js: preloadJsUrls,
        data_packages_js: catalogJsUrls,
        texmf_local: [],
        preload: true,
      });
    });
  }

  /**
   * Stage a file for the next compile. BusyTeX expects all files in a
   * single `compile` message, so writes are accumulated until `compile()`.
   * Re-writing the same path updates the staged content. Parent
   * directories are implied by the path — BusyTeX's virtual filesystem
   * creates them on demand, so there is no separate mkdir step.
   */
  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const normalized = filePath.replace(/\\/g, '/');
    const idx = this.files.findIndex((f) => f.path === normalized);
    if (idx >= 0) {
      this.files[idx] = { path: normalized, contents: content };
    } else {
      this.files.push({ path: normalized, contents: content });
    }
  }

  setMainFile(filename: string): void {
    this.mainFile = filename.replace(/\\/g, '/');
  }

  /**
   * Configure the remote TeX Live endpoint. Missing packages are fetched
   * lazily via a synchronous XHR inside the worker.
   *
   * The raw https endpoint is wrapped in the `scipen-wasm://texlive-remote/...`
   * proxy so the fetch is serviced by the MAIN process (net.fetch). The worker
   * runs from a `file://` origin in packaged builds, where a direct cross-origin
   * XHR to https is blocked by Chromium — the same reason the engine's data
   * packages already load through `scipen-wasm://`. See WasmAssetProtocol.
   */
  setTexliveEndpoint(url: string): void {
    this.remoteEndpoint = url ? toTexliveProxyEndpoint(url) : undefined;
  }

  /**
   * Compile the staged file set. Returns the PDF and `.synctex.gz` as
   * raw bytes; the caller (WASMCompilerProvider) is responsible for
   * persisting them to disk so SyncTeX CLI can read them.
   */
  async compile(options: CompileOptions): Promise<CompileOutput> {
    this.ensureReady();
    const driver = DRIVER_MAP[options.engineType];
    const verbose = options.verbose ?? 'silent';

    return new Promise<CompileOutput>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('BusyTeX compilation timeout (5 minutes)')),
        300_000
      );
      const t0 = performance.now();

      const handler = (ev: MessageEvent<CompileMessage>) => {
        const data = ev.data;

        // Worker logs are forwarded as `{print: msg}` and may interleave
        // with the final compile reply — keep listening until we see
        // `pdf`/`exit_code` field which marks the terminal frame.
        if (data.print !== undefined && data.pdf === undefined && data.exit_code === undefined) {
          logger.debug(data.print);
          return;
        }

        if (data.exception) {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);
          this.abortPending = null;
          reject(new Error(`BusyTeX compilation error: ${data.exception}`));
          return;
        }

        if (data.exit_code !== undefined || data.pdf !== undefined) {
          clearTimeout(timeout);
          this.worker!.removeEventListener('message', handler);
          this.abortPending = null;

          const status = data.exit_code ?? -1;
          const log = data.log ?? '';
          const output: CompileOutput = {
            success: status === 0,
            log,
            status,
          };
          if (data.pdf) {
            output.pdf = data.pdf instanceof Uint8Array ? data.pdf : new Uint8Array(data.pdf);
          }
          if (data.synctex) {
            output.synctex =
              data.synctex instanceof Uint8Array ? data.synctex : new Uint8Array(data.synctex);
          }
          const signals = scrapeSignals(log);
          logger.info('BusyTeX compile done', {
            engine: options.engineType,
            verbose,
            status,
            compileMs: Math.round(performance.now() - t0),
            pdfBytes: output.pdf?.byteLength ?? 0,
            synctexBytes: output.synctex?.byteLength ?? 0,
            hasUnresolved: signals.hasUnresolved,
            catalogUsed: signals.catalogPackagesUsed,
          });
          resolve(output);
        }
      };

      this.worker!.addEventListener('message', handler);
      // Let close()/cancel settle this promise immediately. `reject` here
      // makes the awaiting WASMCompilerProvider.compile() return a failed
      // result (caught in its try/catch), so the UI leaves "compiling".
      this.abortPending = () => {
        clearTimeout(timeout);
        this.worker?.removeEventListener('message', handler);
        this.abortPending = null;
        reject(new BusyTexCancelledError('BusyTeX compilation cancelled'));
      };
      // Files are wrapped to BusyTeX's `{path, contents}` shape. CJK docs
      // pull ctex/xeCJK/fonts from the TeX Live tree (remote endpoint), not
      // from staged assets — so nothing extra is appended here.
      const stagedFiles: Array<{ path: string; contents: string | Uint8Array }> = this.files.map(
        (f) => ({ path: f.path, contents: f.contents })
      );
      const payload = {
        files: stagedFiles,
        main_tex_path: this.mainFile,
        // Auto-detect: pipeline resolves bibtex/makeindex/rerun from the
        // document — `null` is the documented "decide for me" sentinel,
        // not a placeholder. Forcing `false` here would silently break
        // bibliographies, indices, and TOC cross-references.
        bibtex: null,
        makeindex: null,
        rerun: null,
        verbose,
        driver,
        data_packages_js: null,
        remote_endpoint: this.remoteEndpoint,
      };
      this.worker!.postMessage(payload);
    });
  }

  /**
   * Clear staged user files. BusyTeX builds a fresh in-memory FS for every
   * `compile()` call, so there is nothing else to reset between runs.
   */
  flushWorkDir(): void {
    this.files = [];
  }

  close(): void {
    // Settle any in-flight compile first — terminate() fires no event, so the
    // compile promise would otherwise hang until its 5-minute timeout.
    this.abortPending?.();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this._ready = false;
    }
    this.files = [];
  }

  // ====== Internal ======

  private handleMessage(ev: MessageEvent<CompileMessage>): void {
    // Worker logs emitted outside an active compile (e.g. async warnings).
    if (ev.data.print !== undefined) {
      logger.debug(ev.data.print);
    }
  }

  private ensureReady(): void {
    if (!this._ready || !this.worker) {
      throw new Error('BusyTeX engine not ready. Call loadEngine() first.');
    }
  }
}

/**
 * Extract observability signals from BusyTeX's compile log.
 *
 * The pipeline writes two diagnostic lines at the end of every compile
 * (`busytex_pipeline.js:531/533`):
 *   - "TeX packages unresolved (in local or preloaded): ..."
 *   - "Data packages used (not preloaded): ..."
 * We scrape them rather than patching the pipeline. If the upstream
 * format ever changes both signals fall back to safe defaults — we lose
 * observability, not correctness.
 */
function scrapeSignals(log: string): BusyTexSignals {
  const unresolved = log.match(/TeX packages unresolved[^:]*:\s*(.*)/);
  const catalogUsed = log.match(/Data packages used \(not preloaded\):\s*(.*)/);
  return {
    hasUnresolved: !!unresolved && unresolved[1].trim().length > 0,
    catalogPackagesUsed: catalogUsed
      ? catalogUsed[1]
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

/**
 * Resolve a busytex **asset** URL (everything except the worker script itself).
 *
 * Since {@link BUSYTEX_BASE_URL} is an absolute `scipen-wasm://` URL, this is
 * simple concatenation. The resulting URL is identical in dev and prod.
 */
function resolveAssetUrl(fileName: string): string {
  return `${BUSYTEX_BASE_URL}/${fileName}`;
}

/**
 * Wrap a raw TeX Live endpoint into the `scipen-wasm://texlive-remote/...`
 * proxy the main process services. The kpse fetcher concatenates
 * `endpoint + '/' + format + '/' + name`, so we hand it a base whose path
 * carries the real endpoint (base64url) — main decodes it and fetches on our
 * behalf. Already-wrapped or non-http endpoints are returned unchanged.
 */
function toTexliveProxyEndpoint(url: string): string {
  if (url.startsWith('scipen-wasm://')) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  const b64 = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `scipen-wasm://texlive-remote/${b64}`;
}

/**
 * Resolve the busytex **worker script** URL.
 *
 * Why this is separate from {@link resolveAssetUrl}: Chromium enforces a
 * **same-origin policy on classic Worker scripts**. The renderer's origin is
 * `file://` (prod) or `http://localhost` (dev) — neither matches
 * `scipen-wasm://`. Spawning `new Worker('scipen-wasm://...')` from a file://
 * page is rejected at parse time with an opaque "Unknown error" (Chromium
 * suppresses cross-origin worker error details).
 *
 * The fix: load the worker from the renderer's own origin (which is why this
 * helper resolves against `window.location.href`), and let the worker's
 * **internal** `importScripts` / `fetch` calls hit `scipen-wasm://` —
 * those are allowed cross-origin (the protocol is `corsEnabled: true` and
 * the handler emits `Access-Control-Allow-Origin: *`).
 *
 * Path resolution mirrors the asar.unpacked layout:
 *   - dev  : `http://localhost:<port>/wasm/busytex/busytex_worker.js`
 *   - prod : `file:///.../app.asar.unpacked/out/renderer/wasm/busytex/busytex_worker.js`
 *
 * Both are valid same-origin URLs for the renderer's HTML document, so
 * `new URL(relative, window.location.href)` gives the correct absolute URL.
 */
function resolveWorkerUrl(fileName: string): string {
  return new URL(`./wasm/busytex/${fileName}`, window.location.href).href;
}

/**
 * Fetch the manifest written by `scripts/download-busytex-wasm.js`.
 *
 * The manifest is a required build artifact. If it is missing, unreachable,
 * or malformed, the engine cannot know which TeX Live packages to load —
 * that is a packaging fault and we surface it loudly rather than guessing a
 * default that may not match the bundled `.data` files.
 */
async function loadManifest(): Promise<BusyTexManifest> {
  const url = resolveAssetUrl('manifest.json');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `BusyTeX manifest fetch failed (HTTP ${response.status}) at ${url}. Run "pnpm download:busytex" to (re)generate the WASM assets.`
    );
  }
  const data = (await response.json()) as Partial<BusyTexManifest>;
  if (!Array.isArray(data.preload) || data.preload.length === 0) {
    throw new Error(
      `BusyTeX manifest at ${url} has no "preload" packages — assets are incomplete.`
    );
  }
  if (!Array.isArray(data.catalog)) {
    throw new Error(`BusyTeX manifest at ${url} is missing a "catalog" array.`);
  }
  return {
    version: data.version ?? 'unknown',
    mode: data.mode === 'minimal' ? 'minimal' : 'full',
    preload: data.preload,
    catalog: data.catalog,
  };
}
