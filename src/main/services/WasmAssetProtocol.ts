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
import { net, protocol } from 'electron';
import { createLogger } from './LoggerService';

const logger = createLogger('WasmAssetProtocol');

export const WASM_ASSET_PROTOCOL = 'scipen-wasm';

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
