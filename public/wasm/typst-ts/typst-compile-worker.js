/**
 * Typst.ts Compile Worker
 *
 * Bridges the renderer to `typst_ts_web_compiler` (wasm-bindgen ESM).
 * Lives as a static asset under `public/wasm/typst-ts/` (NOT bundled by Vite)
 * for the same reason BusyTeX's `busytex_worker.js` does — Chromium enforces
 * same-origin on classic/module workers, so the worker script itself must
 * be loaded from the renderer's origin (`file://` in prod, `http://localhost`
 * in dev). The renderer's `TypstWasmEngine.ts` resolves this file via
 * `new URL('./wasm/typst-ts/typst-compile-worker.js', window.location.href)`,
 * while `importScripts`/`fetch` from within the worker hit the privileged
 * `scipen-wasm://` scheme (handled by `WasmAssetProtocol`).
 *
 * Protocol (Promise-based on the renderer side via {id}):
 *   { type:'init',    id, ... }                → { type:'initResult',    id, success, error? }
 *   { type:'compile', id, mainPath, sources }  → { type:'compileResult', id, pdf, diagnostics }
 *   { type:'reset',   id }                     → { type:'resetResult',   id, success }
 *
 * Sources are batched on the renderer side and shipped INSIDE the compile
 * message — one IPC roundtrip per compile, not one per file. typst-ts's
 * `add_source()` has overwrite semantics, so unchanged sources retain
 * their memoised layout in the incremental cache (the engine's killer
 * feature — must not be reset between compiles).
 *
 * Why module-mode worker (`{ type: 'module' }`)?
 *   The wasm-bindgen output is an ESM module (`typst_ts_web_compiler.mjs`)
 *   and we want top-level `import()` of it via the resolved
 *   `scipen-wasm://` URL. Classic workers can't do dynamic ESM import.
 */

/* eslint-disable */

let compiler = null;

/**
 * Resolve `scipen-wasm://typst-ts/<path>` from the worker. The renderer
 * passes `assetBaseUrl` at init time so the worker doesn't need to know
 * the scheme — keeps the worker reusable if we ever change scheme names.
 */
function asset(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, '')}/${name}`;
}

/**
 * Fetch one manifest, parse it, return its `fonts` array. Manifest is
 * any URL returning JSON of shape `{ fonts: (string | {name, url})[] }`.
 *
 * The dual shape lets a remote manifest decouple clipboard from binaries:
 *   - string entries are resolved against the manifest's own base URL
 *     (so a local self-contained `public/wasm/typst-ts/manifest.json` with
 *     bare names continues to work);
 *   - `{name, url}` entries take their URL as-is, so a manifest hosted on
 *     gist/jsdelivr can point each font at any CDN (e.g. notofonts/noto-cjk).
 *
 * Throws on network/parse error — callers decide how to handle (local
 * manifest is fatal; remote is best-effort).
 */
async function fetchFontList(manifestUrl) {
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error(`manifest fetch failed (HTTP ${res.status}) at ${manifestUrl}`);
  }
  const manifest = await res.json();
  const raw = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  return raw.map((entry) => {
    if (typeof entry === 'string') return { name: entry, url: null };
    if (entry && typeof entry.name === 'string') {
      return { name: entry.name, url: typeof entry.url === 'string' ? entry.url : null };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Register fonts. Each entry has a `name` and an optional absolute `url`.
 * When `url` is null, the fallback base resolves `${baseUrl}/${name}`.
 * Returns count of successful registrations — failures log to
 * diagnosticPush but never abort (a broken font shouldn't sink init).
 *
 * Order matters: typst-ts resolves font matches by registration order on
 * ties, so the list is treated as priority sequence. Parallel fetch +
 * sequential `add_raw_font` because the latter is a sync cpu-bound wasm
 * call that doesn't benefit from concurrency.
 */
async function registerFontList(builder, fallbackBase, entries, label, diagnosticPush) {
  if (entries.length === 0) return 0;
  const buffers = await Promise.all(
    entries.map(async (entry) => {
      const url = entry.url ?? `${fallbackBase.replace(/\/$/, '')}/${entry.name}`;
      try {
        const r = await fetch(url);
        if (!r.ok) {
          diagnosticPush(`${label} ${entry.name}: HTTP ${r.status} (${url})`);
          return null;
        }
        return { name: entry.name, buf: new Uint8Array(await r.arrayBuffer()) };
      } catch (err) {
        diagnosticPush(`${label} ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }),
  );

  let loaded = 0;
  for (const buf of buffers) {
    if (!buf) continue;
    try {
      await builder.add_raw_font(buf.buf);
      loaded += 1;
    } catch (err) {
      diagnosticPush(`${label} ${buf.name} register: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded;
}

/**
 * Two-tier font loading:
 *   1. LOCAL manifest (mandatory) — bundled fonts from `public/wasm/typst-ts/`.
 *      Hard fails the init if missing because that means the build is broken.
 *   2. REMOTE manifest (optional) — `settings.compiler.typstFontEndpoint` lets
 *      users layer additional fonts (CJK, etc) without growing the install.
 *      Failures are tolerated — the user still gets local fonts and a
 *      diagnostic so they can fix the URL.
 *
 * Endpoint URL semantics:
 *   - If it ends with `.json`, treated as the manifest URL directly. Fonts
 *     with bare `name` resolve against the manifest's own directory; fonts
 *     with explicit `url` win.
 *   - Otherwise treated as a base URL and `/manifest.json` is appended.
 *   This dual form lets users point at either a curated manifest (gist, CDN,
 *   GitHub raw) OR a self-hosted dir served by nginx etc.
 */
async function loadFonts(builder, assetBaseUrl, remoteEndpoint, diagnosticPush) {
  const localList = await fetchFontList(asset(assetBaseUrl, 'manifest.json'));
  const localLoaded = await registerFontList(
    builder,
    asset(assetBaseUrl, 'fonts'),
    localList,
    'local',
    diagnosticPush,
  );

  let remoteLoaded = 0;
  let remoteTotal = 0;
  if (remoteEndpoint) {
    try {
      const trimmed = remoteEndpoint.replace(/\/$/, '');
      const isManifestUrl = /\.json($|\?)/i.test(trimmed);
      const manifestUrl = isManifestUrl ? trimmed : `${trimmed}/manifest.json`;
      // Fallback base is the manifest's own directory (so bare-name entries
      // resolve to siblings of manifest.json).
      const fallbackBase = manifestUrl.replace(/\/[^/]*$/, '');
      const remoteList = await fetchFontList(manifestUrl);
      remoteTotal = remoteList.length;
      remoteLoaded = await registerFontList(builder, fallbackBase, remoteList, 'remote', diagnosticPush);
    } catch (err) {
      // Endpoint unreachable / no manifest — log and proceed with local only.
      diagnosticPush(
        `remote endpoint ${remoteEndpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    localLoaded,
    localTotal: localList.length,
    remoteLoaded,
    remoteTotal,
  };
}

/**
 * `typst_ts_web_compiler` exposes `compile()` whose return shape varies
 * across patch releases. Normalise to `{ pdf, diagnostics }` here so the
 * renderer adapter stays version-agnostic.
 */
function unpackCompileResult(result) {
  if (!result) return { pdf: null, diagnostics: [] };

  let pdfBytes;
  if (result instanceof Uint8Array) {
    pdfBytes = result;
  } else if (result.result instanceof Uint8Array) {
    pdfBytes = result.result;
  } else if (result.pdf instanceof Uint8Array) {
    pdfBytes = result.pdf;
  }

  const pdfBuffer =
    pdfBytes && pdfBytes.byteLength > 0
      ? pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)
      : null;

  const diagnostics = Array.isArray(result.diagnostics)
    ? result.diagnostics.map(normaliseDiagnostic)
    : [];

  return { pdf: pdfBuffer, diagnostics };
}

const SEVERITY_MAP = { error: 1, warning: 2, info: 3, hint: 4 };

/**
 * `wasm-bindgen` exposes diagnostics as either tagged JS objects (newer
 * releases) or `Debug`-formatted Rust strings (older). Try the object
 * shape first; on miss, scrape the common Rust-debug pattern. Anything
 * unparseable becomes a generic error so the user still sees the message.
 */
function normaliseDiagnostic(d) {
  const emptyRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

  if (d && typeof d === 'object' && typeof (d.message ?? d.msg) === 'string') {
    const msg = d.message ?? d.msg;
    const severity =
      typeof d.severity === 'string'
        ? SEVERITY_MAP[d.severity.toLowerCase()] ?? 1
        : typeof d.severity === 'number'
          ? d.severity
          : 1;
    return { range: d.range ?? emptyRange, severity, message: msg };
  }

  const str = typeof d === 'string' ? d : String(d);
  const rustMatch = /message:\s*"([^"]*)"/.exec(str);
  if (rustMatch) {
    const sev = /severity:\s*(\w+)/.exec(str);
    const severity = SEVERITY_MAP[(sev?.[1] ?? '').toLowerCase()] ?? 1;
    return { range: emptyRange, severity, message: rustMatch[1] };
  }
  return { range: emptyRange, severity: 1, message: str };
}

self.onmessage = async (event) => {
  const msg = event.data;
  const replyId = msg.id;

  switch (msg.type) {
    case 'init': {
      try {
        // Dynamic ESM import of the wasm-bindgen glue. `/* @vite-ignore */`
        // would normally suppress Vite's static-analyser, but this file is
        // a plain JS asset (not processed by Vite), so the comment is moot
        // — keep the import truly dynamic.
        const wasmModule = await import(msg.wasmJsUrl);
        const wasmBinary = await fetch(msg.wasmBinaryUrl).then((r) => r.arrayBuffer());

        // wasm-bindgen's default export wants an ArrayBuffer / WebAssembly
        // module / etc. Passing the ArrayBuffer directly is the most
        // compatible across 0.6.x patch versions.
        await wasmModule.default(wasmBinary);

        const builder = new wasmModule.TypstCompilerBuilder();
        // `set_dummy_access_model` means "compiler does not read from any
        // disk-like model" — all sources come from in-memory `add_source`
        // calls. Without it the compiler would try to resolve `\@`-prefixed
        // package paths against a missing access model and panic.
        builder.set_dummy_access_model();

        const fontDiagnostics = [];
        const fontStats = await loadFonts(
          builder,
          msg.assetBaseUrl,
          msg.fontEndpoint || null,
          (m) => fontDiagnostics.push(m),
        );
        compiler = await builder.build();

        self.postMessage({
          type: 'initResult',
          id: replyId,
          success: true,
          fontStats,
          fontDiagnostics,
        });
      } catch (error) {
        self.postMessage({
          type: 'initResult',
          id: replyId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'compile': {
      if (!compiler) {
        self.postMessage({ type: 'compileResult', id: replyId, success: false, error: 'compiler not initialised', diagnostics: [] });
        return;
      }
      try {
        // Batch-stage all sources in one tight loop before compiling. Each
        // `add_source` is `O(content)` and `overwrites by path` — unchanged
        // entries keep their memoised layout in the wasm-side incremental
        // cache, so re-staging the full project tree every compile costs
        // only the IO of re-reading source content, NOT recomputation.
        const sources = Array.isArray(msg.sources) ? msg.sources : [];
        for (const s of sources) {
          compiler.add_source(s.path, s.content);
        }

        // compile(mainPath, accessModel=null, format='pdf', pageOffset=0).
        // The 4-arg shape is stable across 0.5.x/0.6.x; older 0.4 used a
        // single-arg form which we don't support.
        const result = compiler.compile(msg.mainPath, null, 'pdf', 0);
        const { pdf, diagnostics } = unpackCompileResult(result);

        const hasError =
          result?.hasError === true ||
          (!pdf && diagnostics.some((d) => d.severity === 1));

        if (pdf) {
          self.postMessage(
            { type: 'compileResult', id: replyId, success: !hasError, pdf, diagnostics },
            // Transfer ownership of the PDF buffer to avoid a 1+ MB copy
            // across the renderer/worker boundary on every compile.
            [pdf],
          );
        } else {
          self.postMessage({ type: 'compileResult', id: replyId, success: !hasError, pdf: null, diagnostics });
        }
      } catch (error) {
        self.postMessage({
          type: 'compileResult',
          id: replyId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          diagnostics: [],
        });
      }
      break;
    }

    case 'reset': {
      if (compiler) {
        try {
          compiler.reset();
        } catch {
          // reset() failure is not fatal — the renderer's next compile will
          // notice the dirty state and may choose to dispose+reinit.
        }
      }
      self.postMessage({ type: 'resetResult', id: replyId, success: true });
      break;
    }

    default:
      // Unknown messages are dropped — no postMessage so the renderer
      // adapter's pending-request map doesn't accidentally resolve.
      break;
  }
};
