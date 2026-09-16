/**
 * @file WasmAssetProtocol - Custom protocol for app-bundled WASM assets
 * @description Serves WASM engines (BusyTeX, future tinymist, etc.) via
 *              `scipen-wasm://` so a renderer Worker spawned from `file://`
 *              can actually `fetch()` them.
 * @depends electron protocol/net, app, fs
 *
 * Why a dedicated protocol instead of reusing `scipen-file://`?
 *   - `scipen-file://` enforces a runtime-mutable directory allowlist
 *     (project paths added on open) and an extension allowlist that
 *     excludes `.wasm` / `.js` / `.data` by design.
 *   - WASM assets are static, app-bundled, and have a single root
 *     (`<rendererDist>/wasm/`). A separate scheme lets us hardcode
 *     the root and skip the allowlist machinery — simpler, safer.
 *
 * Why this protocol is needed at all (Chromium `file://` limitations):
 *   - A Worker created from `file:///app.asar/.../busytex_worker.js`
 *     can `importScripts(file:///...)` (sync, allowed) but **not**
 *     `fetch(file:///...)` — Chromium blocks fetch on the file: scheme
 *     for security. BusyTeX's pipeline calls `fetch()` on every
 *     `texlive-*.js` data package descriptor, which then throws
 *     "TypeError: Failed to fetch" and the engine never initializes.
 *   - Custom protocols registered with `supportFetchAPI: true` bypass
 *     this restriction.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { app, net, protocol } from 'electron';
import { createLogger } from './LoggerService';
import { TexliveRemoteCache } from './TexliveRemoteCache';

const logger = createLogger('WasmAssetProtocol');

export const WASM_ASSET_PROTOCOL = 'scipen-wasm';

/**
 * Reserved host under {@link WASM_ASSET_PROTOCOL} for proxying the BusyTeX
 * on-demand TeX Live fetch. The worker builds
 * `scipen-wasm://texlive-remote/<base64url(endpoint)>/<format>/<name>` and the
 * MAIN process fetches the real `<endpoint>/<format>/<name>` on its behalf —
 * the worker's own `file://` origin can't do that cross-origin request in a
 * packaged app, but main (net.fetch) has no such restriction. See
 * {@link handleTexliveRemote}.
 */
const TEXLIVE_REMOTE_HOST = 'texlive-remote';

/**
 * Disk cache for proxied TeX Live fetches. Without it every fetched file
 * (CJK styles, Fandol fonts, tfm/vf probes) lives only in the BusyTeX
 * worker's in-memory WASM FS, so an app relaunch or a user cancel
 * (which terminates the worker) re-downloads the whole set over
 * synchronous XHR — often minutes on a slow link. With it, only the
 * first compile after install pays the network.
 *
 * Opt-out: `SCIPEN_TEXLIVE_REMOTE_CACHE=0` restores the pure-streaming
 * proxy. Size cap override: `SCIPEN_TEXLIVE_CACHE_MAX_BYTES`.
 */
let texliveCache: TexliveRemoteCache | null = null;

export function getTexliveRemoteCache(): TexliveRemoteCache | null {
  if (process.env.SCIPEN_TEXLIVE_REMOTE_CACHE === '0') return null;
  if (!texliveCache) {
    const maxBytes = Number.parseInt(process.env.SCIPEN_TEXLIVE_CACHE_MAX_BYTES ?? '', 10);
    texliveCache = new TexliveRemoteCache({
      cacheDir: path.join(app.getPath('userData'), 'scipen-studio', 'texlive-remote-cache'),
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined,
    });
  }
  return texliveCache;
}

let isRegistered = false;

/**
 * Must be called BEFORE `app.whenReady()` so Chromium treats the
 * scheme as standard/secure/fetch-capable. `protocol.handle()` (the
 * runtime handler) is then registered after ready.
 */
export function registerWasmAssetSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WASM_ASSET_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
  logger.info(`[WasmAssetProtocol] Scheme privileged: ${WASM_ASSET_PROTOCOL}://`);
}

/**
 * Resolve the on-disk root of bundled WASM assets. Exported so other
 * main-side modules (e.g. capability probes that fs.read manifests
 * outside the protocol handler) share one source of truth for the path.
 *
 * Why `import.meta.url` and NOT `app.getAppPath()`:
 *   - `app.getAppPath()` resolves to whichever directory holds the
 *     nearest `package.json` to the main script. In packaged builds
 *     (`app.asar`) it points at the asar root and the join works. In
 *     dev / e2e launches (`electron out/main/index.js` with no
 *     `package.json` next to the script), Electron falls back to
 *     `path.dirname(mainScript) = out/main/`, and the join produces
 *     `out/main/out/renderer/wasm` — which doesn't exist. Every wasm
 *     asset request then 500s.
 *   - `import.meta.url` is the URL of THIS module wherever it ends up.
 *     The main bundle lives at `<root>/out/main/index.js` in dev and at
 *     `<asar>/out/main/index.js` in prod (electron-builder preserves
 *     this layout). Going up one dir and into `renderer/wasm` is the
 *     correct path in both cases, and the `asarUnpack` rule in
 *     electron-builder.json5 ensures `out/renderer/wasm/**` ends up at
 *     the same relative location inside `app.asar.unpacked/` — Electron
 *     transparently redirects the read.
 *
 * Layout (kept in sync with electron-vite + electron-builder.json5):
 *   dev   : <repoRoot>/out/main/index.js  →  <repoRoot>/out/renderer/wasm/
 *   prod  : <asar>/out/main/index.js      →  <asar>/out/renderer/wasm/
 *                                            (asarUnpack redirects to
 *                                             app.asar.unpacked/out/renderer/wasm/)
 */
export function resolveWasmRoot(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // thisDir = .../out/main  →  .../out/renderer/wasm
  return path.resolve(thisDir, '..', 'renderer', 'wasm');
}

/**
 * Register the runtime handler. Idempotent.
 */
export function registerWasmAssetProtocol(): void {
  if (isRegistered) {
    logger.info('[WasmAssetProtocol] Already registered, skipping');
    return;
  }

  const wasmRoot = resolveWasmRoot();
  logger.info(`[WasmAssetProtocol] Serving from ${wasmRoot}`);

  protocol.handle(WASM_ASSET_PROTOCOL, async (request) => {
    try {
      // Parse `scipen-wasm://busytex/busytex.js` into a path inside wasm/.
      // Chromium puts the first segment in `url.host` for standard schemes.
      const url = new URL(request.url);

      // BusyTeX on-demand TeX Live fetch — proxied through main (see host doc).
      if (url.host === TEXLIVE_REMOTE_HOST) {
        return await handleTexliveRemote(url);
      }

      const requestPath = decodeURIComponent(`${url.host}${url.pathname}`);
      const filePath = path.normalize(path.join(wasmRoot, requestPath));

      // Path-traversal guard: the resolved file must remain under wasmRoot.
      // Stops `scipen-wasm://busytex/../../../secrets` style escapes.
      if (!filePath.startsWith(wasmRoot)) {
        logger.warn(`[WasmAssetProtocol] Path traversal blocked: ${request.url}`);
        return new Response('Forbidden', { status: 403 });
      }

      const fileUrl = `file://${process.platform === 'win32' ? '/' : ''}${filePath.replace(/\\/g, '/')}`;
      const response = await net.fetch(fileUrl, { headers: request.headers });

      // Chromium uses Content-Type to pick the right decode path for
      // WASM streaming compile and ESM Worker scripts. Override the
      // generic octet-stream default that file:// fetch returns.
      const headers = new Headers(response.headers);
      headers.set('Content-Type', getMimeType(filePath));
      headers.set('Cache-Control', 'public, max-age=31536000');
      // Cross-origin access from `file://` / `http://localhost` workers.
      // The worker script itself is loaded same-origin (renderer URL), but
      // its `importScripts` and `fetch` calls hit this protocol cross-origin.
      // `corsEnabled: true` in the privileged scheme declaration enables the
      // mechanism; this header makes the actual response acceptable to
      // Chromium's CORS check. `*` is safe here because the protocol is
      // app-bundled and read-only — no credentials or user data are served.
      headers.set('Access-Control-Allow-Origin', '*');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      logger.error('[WasmAssetProtocol] Request failed', { error, url: request.url });
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  isRegistered = true;
  logger.info(`[WasmAssetProtocol] Handler registered: ${WASM_ASSET_PROTOCOL}://`);
}

/**
 * Proxy a BusyTeX on-demand TeX Live request to the real remote endpoint.
 *
 * URL shape: `scipen-wasm://texlive-remote/<base64url(endpoint)>/<format>/<name>`.
 * The endpoint base is carried in the path (base64url) so main needs no shared
 * state with the renderer. We fetch `<endpoint>/<format>/<name>` from main via
 * `net.fetch` — not subject to the `file://`-origin cross-origin restriction
 * that blocks the worker's own XHR in packaged builds — and preserve the real
 * status so BusyTeX records a proper 404 "miss".
 */
async function handleTexliveRemote(url: URL): Promise<Response> {
  const segments = url.pathname.replace(/^\/+/, '').split('/');
  const encodedBase = segments.shift();
  if (!encodedBase || segments.length === 0) {
    return new Response('Bad Request', { status: 400 });
  }

  let endpointBase: string;
  try {
    endpointBase = Buffer.from(
      encodedBase.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Only proxy plain http(s) endpoints — never file:// or other schemes.
  if (!/^https?:\/\/\S+$/i.test(endpointBase)) {
    logger.warn('[WasmAssetProtocol] Rejected non-http texlive endpoint');
    return new Response('Forbidden', { status: 403 });
  }

  // `segments` keep their percent-encoding (url.pathname is not decoded), so
  // the reconstructed URL matches what the worker asked for.
  const remoteUrl = `${endpointBase.replace(/\/+$/, '')}/${segments.join('/')}`;

  // Disk-cache fast path. Keyed by the full remote URL, so a different
  // endpoint configured in Settings gets a different key space. 404 misses
  // are cached too (with a TTL inside the cache) — kpathsea probes produce
  // many miss requests and re-paying them per launch is pure latency.
  const cache = getTexliveRemoteCache();
  if (cache) {
    const entry = await cache.get(remoteUrl);
    if (entry) {
      logger.debug('[WasmAssetProtocol] texlive-remote cache hit', {
        status: entry.status,
        url: remoteUrl,
      });
      return new Response(entry.body, {
        status: entry.status,
        headers: texliveRemoteHeaders(entry.status),
      });
    }
  }

  try {
    const response = await net.fetch(remoteUrl);

    // 200 — buffer, store, serve. Buffering is required to persist the body;
    // largest realistic payloads are CJK fonts (tens of MB), fine in memory.
    if (response.status === 200 && cache) {
      const body = Buffer.from(await response.arrayBuffer());
      await cache.put(remoteUrl, body);
      logger.debug('[WasmAssetProtocol] texlive-remote stored', {
        bytes: body.byteLength,
        url: remoteUrl,
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: texliveRemoteHeaders(response.status),
      });
    }

    // 404 — record the miss so future compiles skip the network round trip.
    if (response.status === 404 && cache) {
      await cache.putMiss(remoteUrl);
    }

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    logger.warn('[WasmAssetProtocol] TeX Live proxy fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // 502 (not 404) so BusyTeX doesn't cache this as a permanent "miss".
    return new Response('Bad Gateway', { status: 502 });
  }
}

/**
 * Headers for cache-served responses. CORS is mandatory — the worker is
 * cross-origin to `scipen-wasm://` — and kpathsea consumes raw bytes, so a
 * neutral content type is sufficient (the streaming path forwards whatever
 * the endpoint sent; that variety is not worth persisting).
 */
function texliveRemoteHeaders(status: number): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Type', status === 200 ? 'application/octet-stream' : 'text/plain');
  return headers;
}

/**
 * Measure round-trip latency against a TeX Live remote endpoint.
 *
 * Lives beside {@link handleTexliveRemote} on purpose: it must exercise the
 * same `net.fetch` path the real package fetches use, or the number would be
 * meaningless (a renderer-side probe would take a different route entirely,
 * and the CSP blocks it anyway).
 *
 * Never throws — the result is a discriminated value so the settings UI can
 * render "reachable / unreachable" without a try/catch.
 */
export async function probeTexliveEndpoint(
  endpoint: string,
  timeoutMs = 8000
): Promise<{ ok: boolean; latencyMs?: number; status?: number; error?: string }> {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) {
    return { ok: false, error: 'Endpoint must be an http(s) URL' };
  }

  // Format 26 + a file every TeX Live tree carries. A 404 still proves the
  // endpoint is alive and routing, so it counts as reachable — only transport
  // failures and 5xx mean "this endpoint will not serve packages".
  const probeUrl = `${base}/26/article.cls`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await net.fetch(probeUrl, { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - started);
    if (response.status >= 500) {
      return { ok: false, status: response.status, error: `Server error ${response.status}` };
    }
    return { ok: true, latencyMs, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.wasm':
      return 'application/wasm';
    case '.js':
    case '.mjs':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.data':
      // Emscripten `.data` packages are raw binary heap dumps.
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}
