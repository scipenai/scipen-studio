/**
 * @file busytex-process/env.ts — engine host environment and asset paths
 *
 * Read once at module evaluation. Utility processes cannot call
 * app.getPath(), so every location arrives through env vars injected by
 * BusyTexProcessClient. Deliberately side-effect free: the missing-assets
 * exit lives in the entry, so importing this module never kills a process.
 */

import * as nodePath from 'node:path';

export const WASM_ASSETS_DIR = process.env.WASM_ASSETS_DIR ?? '';
export const TEXLIVE_CACHE_DIR = process.env.TEXLIVE_CACHE_DIR ?? '';
/** Incremental build artifacts; empty keeps them in memory only. */
export const BUILD_CACHE_DIR = process.env.BUSYTEX_BUILD_CACHE_DIR ?? '';
export const SCHEME = 'scipen-wasm://busytex/';
/** Ceiling for one synchronous remote fetch; kpse probes must not hang. */
export const SYNC_FETCH_TIMEOUT_S = 60;
/** Hard ceiling for the whole init handshake (wasm + data packages). */
export const LOAD_TIMEOUT_MS = 300_000;
/** Hard ceiling for one compile (matches the previous renderer-side limit). */
export const COMPILE_TIMEOUT_MS = 600_000;

export function resolveAssetPath(url: string): string | null {
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
export function toDiskPath(p: unknown): unknown {
  if (typeof p === 'string' && p.startsWith(SCHEME)) {
    return nodePath.join(WASM_ASSETS_DIR, p.slice(SCHEME.length).split('?')[0]);
  }
  return p;
}
