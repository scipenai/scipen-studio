/**
 * @file busytex-process/browserShims.ts — browser-worker globals on plain Node
 *
 * The vendored BusyTeX worker targets a browser Web Worker. These shims give
 * it what it expects inside this UtilityProcess: `self`, `importScripts`,
 * scheme-aware fs reads, and the CommonJS globals the emscripten glue's Node
 * branch looks for. Network globals (`fetch`, `XMLHttpRequest`) live in
 * remoteFetch.ts. Each installer is explicit — importing this module changes
 * nothing until the entry calls it.
 */

import fs from 'node:fs';
import * as nodePath from 'node:path';
import vm from 'node:vm';
import { WASM_ASSETS_DIR, resolveAssetPath, toDiskPath } from './env';

/** The browser globals this process installs for the vendored worker code. */
export const browserGlobals = globalThis as unknown as {
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

/** Route scheme URLs handed to plain fs calls onto the assets dir. */
export function installFsPathTranslation(): void {
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
}

export function installWorkerGlobals(): void {
  browserGlobals.self = globalThis;

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
}
