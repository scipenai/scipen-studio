/**
 * @file TypstWasmEngine.ts - Typst.ts WASM Engine Wrapper
 * @description Promise-based adapter over the `typst-compile-worker.js`
 *              message protocol. Mirrors BusyTeX's shape so both wasm
 *              engines share the same renderer-side ergonomics.
 * @depends Typst.ts WASM artefacts under public/wasm/typst-ts/
 *          (downloaded by `scripts/download-typst-wasm.js`)
 *
 * Why a renderer-level adapter (and not a direct npm dependency on
 * `@myriaddreamin/typst.ts`)?
 *   - That package bundles its own Worker loading flow that assumes
 *     `import.meta.url` resolves to a Vite-handled URL; Electron's
 *     `file://` renderer breaks that assumption.
 *   - Removing the npm dep keeps the build deterministic — the only
 *     versioned surface is the .wasm/.mjs/.json artefacts under
 *     `public/wasm/typst-ts/`.
 *   - This file is intentionally parallel to {@link BusyTexEngine} so the
 *     Provider layer can treat both engines uniformly.
 *
 * Source-staging design:
 *   - `writeFile` is renderer-LOCAL — it only updates `stagedSources` and
 *     does NOT cross the worker boundary. This keeps writeFile sync-fast
 *     for callers staging dozens of project files in a tight loop.
 *   - The full source set is shipped in ONE message inside `compile`. The
 *     worker batch-calls `add_source` (overwrite semantics) then compiles,
 *     so unchanged files retain their memoised layout in the typst-ts
 *     incremental cache. ONE IPC roundtrip per compile, not N+1.
 *   - `flushSources()` exists for "switching project" reset; it MUST NOT
 *     be called between compiles in the same project — doing so would
 *     nuke the incremental cache (typst-ts's killer feature).
 *
 * Long-session memory note: Typst's incremental compiler accumulates
 * memoised layout state across compiles (typst#334 — multi-GB after
 * hours of `typst watch`). The Provider is responsible for recycling
 * this engine after a configured compile count (`close()` + lazy
 * `loadEngine()` next compile). The engine itself doesn't enforce the
 * cap — that lets the Provider tune the threshold per-deployment.
 */

import { createLogger } from './LogService';

const logger = createLogger('TypstWasmEngine');

/**
 * Where the worker fetches every wasm/font asset from. We route through
 * the `scipen-wasm://` custom protocol because:
 *   - The renderer (`file://` in prod) cannot `fetch()` `file://` URLs
 *     (Chromium security restriction).
 *   - `scipen-wasm://` is registered `corsEnabled: true` so the worker
 *     (cross-origin from `file://`) can fetch with `Access-Control-Allow-Origin: *`.
 * Same protocol BusyTeX uses — see {@link WasmAssetProtocol.ts}.
 */
const TYPST_ASSET_BASE = 'scipen-wasm://typst-ts';
const WORKER_RELATIVE_URL = './wasm/typst-ts/typst-compile-worker.js';
const COMPILER_MJS = 'typst_ts_web_compiler.mjs';
const COMPILER_WASM = 'typst_ts_web_compiler_bg.wasm';
const MANIFEST_FILE = 'manifest.json';

/**
 * Build-time manifest emitted by `scripts/download-typst-wasm.js`. The
 * renderer reads `compilerVersion` for logging/observability; the worker
 * reads the same manifest internally to discover the font list.
 */
interface TypstManifest {
  compilerVersion: string;
  fontsTag: string;
  compiler: { mjs: string; wasm: string };
  fonts: string[];
}

/**
 * Diagnostic shape forwarded from the worker. The Studio-facing layer
 * (`TypstWasmCompilerProvider`) maps these into the unified
 * `CompileResult.parsedErrors` form.
 */
export interface TypstDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=Error 2=Warning 3=Info 4=Hint (LSP severities). */
  severity: number;
  message: string;
}

export interface TypstCompileOutput {
  /** True ⇔ compile produced a PDF AND no error-severity diagnostics. */
  success: boolean;
  pdf?: Uint8Array;
  diagnostics: TypstDiagnostic[];
}

/**
 * Font-loading snapshot exposed by {@link TypstWasmEngine.fontContext}.
 * Read-only — recomputed on every {@link TypstWasmEngine.loadEngine} call.
 */
export interface TypstFontContext {
  /** True if `settings.compiler.typstFontEndpoint` was non-empty at init. */
  endpointConfigured: boolean;
  /**
   * True if endpoint was configured AND its manifest fetched cleanly.
   * False when endpoint was misconfigured/unreachable or simply not set.
   * Distinguish from {@link endpointConfigured} to give the user a precise
   * hint ("URL down" vs "URL not set").
   */
  endpointReachable: boolean;
  /** Count of local-manifest fonts that successfully registered. */
  localLoaded: number;
  /** Count of remote-manifest fonts that successfully registered. */
  remoteLoaded: number;
}

interface WorkerFontStats {
  localLoaded: number;
  localTotal: number;
  remoteLoaded: number;
  remoteTotal: number;
}

interface WorkerMessage {
  type: string;
  id?: number;
  success?: boolean;
  error?: string;
  pdf?: ArrayBuffer | null;
  diagnostics?: TypstDiagnostic[];
  fontStats?: WorkerFontStats;
  fontDiagnostics?: string[];
}

type PendingRequest = {
  resolve: (msg: WorkerMessage) => void;
  reject: (err: Error) => void;
};

/**
 * Wraps `typst-compile-worker.js` in a Promise API.
 *
 * Lifecycle:
 *   1. `new TypstWasmEngine()`
 *   2. `await loadEngine()`         — spawn worker, init wasm, register fonts
 *   3. `writeFile(path, content)`+  — stage all `.typ` sources in memory
 *   4. `setMainFile(path)`
 *   5. `await compile()`            — returns `{ pdf, diagnostics }`
 *   6. (loop steps 3-5)
 *   7. `close()`                    — terminate worker
 *
 * Why a single worker for the engine's lifetime?
 *   Spawning the worker costs ~500 ms (wasm download + instantiate + font
 *   registration). Recycling between every compile would dominate
 *   end-to-end latency. The cost is amortised across all compiles in a
 *   session, and recycled deliberately only when {@link close} is called
 *   (e.g. Provider hits its memory ceiling).
 */
export class TypstWasmEngine {
  private worker: Worker | null = null;
  private _ready = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  /**
   * Renderer-side source table. Indexed by path to make `writeFile`'s
   * overwrite path O(n) (acceptable: project size is in the tens to
   * low-hundreds of files). Shipped wholesale to the worker on every
   * `compile()` call.
   */
  private stagedSources = new Map<string, string>();
  private mainPath = '/main.typ';
  /**
   * Optional remote font endpoint. MUST be set before {@link loadEngine}
   * — the worker registers all fonts up-front (typst-ts API limitation:
   * `add_raw_font` is only valid before `builder.build()`). Changing the
   * endpoint after init requires {@link close} + reload.
   */
  private fontEndpoint = '';

  /**
   * Snapshot of font-loading state from the last successful init. Read by
   * the Provider when a compile diagnostic mentions a missing font, so the
   * user-facing hint can be specific about which path failed:
   *   - endpoint not configured → "configure one"
   *   - endpoint configured but reachable but missing the font → "your manifest doesn't include it"
   *   - endpoint configured but unreachable → "URL is down"
   * Empty default lets the Provider degrade gracefully if read before init.
   */
  private _fontContext: TypstFontContext = {
    endpointConfigured: false,
    endpointReachable: false,
    localLoaded: 0,
    remoteLoaded: 0,
  };

  get ready(): boolean {
    return this._ready;
  }

  /** See {@link _fontContext} doc. Stable snapshot, do not mutate. */
  get fontContext(): TypstFontContext {
    return this._fontContext;
  }

  /**
   * Configure an additional font endpoint to layer on top of the bundled
   * local fonts. See `AppSettings.compiler.typstFontEndpoint`. Empty string
   * disables (local fonts only).
   */
  setFontEndpoint(url: string): void {
    this.fontEndpoint = url.trim();
  }

  /**
   * Spawn the worker and initialise the wasm compiler. Fonts are loaded
   * inside the worker via the manifest — the renderer only forwards URLs.
   */
  async loadEngine(): Promise<void> {
    if (this._ready && this.worker) return;

    const t0 = performance.now();
    const manifest = await loadManifest();
    logger.info('Loading Typst WASM engine', {
      compilerVersion: manifest.compilerVersion,
      fontsTag: manifest.fontsTag,
      localFontCount: manifest.fonts.length,
      fontEndpoint: this.fontEndpoint || '<none>',
    });

    // Same module-mode rationale as the worker file's docstring.
    const workerUrl = new URL(WORKER_RELATIVE_URL, window.location.href).href;
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);

    const initReply = await this.request<WorkerMessage>('init', {
      wasmJsUrl: `${TYPST_ASSET_BASE}/${manifest.compiler.mjs || COMPILER_MJS}`,
      wasmBinaryUrl: `${TYPST_ASSET_BASE}/${manifest.compiler.wasm || COMPILER_WASM}`,
      assetBaseUrl: TYPST_ASSET_BASE,
      fontEndpoint: this.fontEndpoint || null,
    });

    if (!initReply.success) {
      this.disposeWorker();
      throw new Error(`Typst WASM init failed: ${initReply.error ?? 'unknown'}`);
    }

    this._ready = true;
    const stats = initReply.fontStats;
    const diagnostics = initReply.fontDiagnostics ?? [];
    // The worker prefixes endpoint-fetch failures with `remote endpoint `
    // (see typst-compile-worker.js loadFonts catch block) — that single
    // string is the signal for "configured but unreachable".
    const endpointConfigured = !!this.fontEndpoint;
    const endpointFetchFailed = diagnostics.some((d) => d.startsWith('remote endpoint '));
    this._fontContext = {
      endpointConfigured,
      endpointReachable: endpointConfigured && !endpointFetchFailed,
      localLoaded: stats?.localLoaded ?? 0,
      remoteLoaded: stats?.remoteLoaded ?? 0,
    };
    logger.info('Typst WASM engine ready', {
      loadMs: Math.round(performance.now() - t0),
      localFonts: stats ? `${stats.localLoaded}/${stats.localTotal}` : 'unknown',
      remoteFonts: stats ? `${stats.remoteLoaded}/${stats.remoteTotal}` : 'unknown',
      fontContext: this._fontContext,
    });
    // Font failures don't abort init (a missing CJK font is a degraded
    // experience, not a broken engine). Surface them at warn level so a
    // user diagnosing "Chinese glyphs missing" can see exactly why.
    for (const diag of diagnostics) {
      logger.warn(`Typst font issue: ${diag}`);
    }
  }

  /**
   * Stage a `.typ` source for the next compile. SYNCHRONOUS, renderer-side
   * only — does NOT cross the worker boundary. The staged sources are
   * shipped in one batch at `compile()` time.
   *
   * Re-writing the same path overwrites the staged content. Paths are
   * project-relative with a leading `/` (matches the typst-ts virtual-fs
   * convention — see worker docs).
   */
  writeFile(filePath: string, content: string): void {
    this.ensureReady();
    this.stagedSources.set(this.normalisePath(filePath), content);
  }

  setMainFile(filePath: string): void {
    this.mainPath = this.normalisePath(filePath);
  }

  /**
   * Compile the staged sources against `mainPath`. Ships the full source
   * table in one message — the worker batch-calls `add_source` (overwrite
   * semantics; unchanged sources keep their memoised layout in typst-ts's
   * incremental cache) then compiles.
   *
   * Returns the PDF bytes plus any diagnostics (errors AND warnings) —
   * the caller decides how to surface them (Provider maps to
   * parsedErrors/parsedWarnings).
   */
  async compile(): Promise<TypstCompileOutput> {
    this.ensureReady();
    const t0 = performance.now();

    const sources = Array.from(this.stagedSources, ([path, content]) => ({ path, content }));
    const reply = await this.request<WorkerMessage>('compile', {
      mainPath: this.mainPath,
      sources,
    });

    const pdfBytes = reply.pdf ? new Uint8Array(reply.pdf) : undefined;
    const diagnostics = reply.diagnostics ?? [];
    const success = !!reply.success && !!pdfBytes;

    logger.info('Typst WASM compile done', {
      compileMs: Math.round(performance.now() - t0),
      success,
      sources: sources.length,
      pdfBytes: pdfBytes?.byteLength ?? 0,
      diagnostics: diagnostics.length,
    });

    if (reply.error && !success) {
      // Worker-reported exception (init/parse failure inside the compiler).
      // Surface as a diagnostic so the user sees it in the log panel.
      diagnostics.push({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: 1,
        message: reply.error,
      });
    }

    return { success, pdf: pdfBytes, diagnostics };
  }

  /**
   * Clear staged sources AND reset the worker's compiler state. Use ONLY
   * when switching to an unrelated project — calling this between compiles
   * in the same project would nuke the typst-ts incremental cache that
   * makes second-compile sub-100ms.
   */
  async flushSources(): Promise<void> {
    this.stagedSources.clear();
    if (this._ready && this.worker) {
      // Best-effort: a reset failure is non-fatal (next compile re-stages
      // the source table from scratch anyway).
      await this.request<WorkerMessage>('reset', {}).catch(() => undefined);
    }
  }

  close(): void {
    this.disposeWorker();
    this.stagedSources.clear();
    this._fontContext = {
      endpointConfigured: false,
      endpointReachable: false,
      localLoaded: 0,
      remoteLoaded: 0,
    };
  }

  // ====== Internal ======

  private disposeWorker(): void {
    if (this.worker) {
      this.worker.removeEventListener('message', this.handleMessage);
      this.worker.removeEventListener('error', this.handleWorkerError);
      this.worker.terminate();
      this.worker = null;
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Typst WASM engine disposed'));
    }
    this.pendingRequests.clear();
    this._ready = false;
  }

  private handleMessage = (event: MessageEvent<WorkerMessage>): void => {
    const data = event.data;
    if (data.id === undefined) return;
    const pending = this.pendingRequests.get(data.id);
    if (!pending) return;
    this.pendingRequests.delete(data.id);
    pending.resolve(data);
  };

  private handleWorkerError = (err: ErrorEvent): void => {
    logger.error('Typst WASM worker error', {
      message: err.message,
      filename: err.filename,
      lineno: err.lineno,
    });
    // Reject every in-flight request so callers don't hang. Subsequent
    // calls will throw `not ready` via `ensureReady` until `loadEngine`
    // is called again.
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(`Typst WASM worker error: ${err.message || 'unknown'}`));
    }
    this.pendingRequests.clear();
    this._ready = false;
  };

  private request<T extends WorkerMessage>(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Typst WASM engine has no worker'));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      // 5-minute upper bound matches BusyTeX. typst-ts compiles are
      // usually sub-second; a hung worker indicates an infinite layout
      // loop in the source, not a slow doc — better to surface a timeout
      // than have the renderer wait forever.
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Typst WASM request '${type}' timed out`));
      }, 300_000);
      this.pendingRequests.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg as T);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.worker!.postMessage({ type, id, ...payload });
    });
  }

  private ensureReady(): void {
    if (!this._ready || !this.worker) {
      throw new Error('Typst WASM engine not ready. Call loadEngine() first.');
    }
  }

  /**
   * Normalise path separators and ensure a leading `/`. typst-ts treats
   * its virtual filesystem as Unix-like; Windows paths would silently
   * fail to resolve sub-modules (e.g. `#import "lib/x.typ"`).
   */
  private normalisePath(filePath: string): string {
    const slash = filePath.replace(/\\/g, '/');
    return slash.startsWith('/') ? slash : `/${slash}`;
  }
}

async function loadManifest(): Promise<TypstManifest> {
  const url = `${TYPST_ASSET_BASE}/${MANIFEST_FILE}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Typst manifest fetch failed (HTTP ${response.status}) at ${url}. ` +
        `Run "pnpm download:typst-wasm" to (re)generate the WASM assets.`,
    );
  }
  const data = (await response.json()) as Partial<TypstManifest>;
  if (!data.compiler?.mjs || !data.compiler?.wasm) {
    throw new Error(`Typst manifest at ${url} is missing compiler entries — assets incomplete.`);
  }
  if (!Array.isArray(data.fonts)) {
    throw new Error(`Typst manifest at ${url} is missing a 'fonts' array.`);
  }
  return {
    compilerVersion: data.compilerVersion ?? 'unknown',
    fontsTag: data.fontsTag ?? 'unknown',
    compiler: data.compiler,
    fonts: data.fonts,
  };
}
