/**
 * @file worker-shim.mjs - Node worker_threads shim for the BusyTeX web worker
 * @description Lets `public/wasm/busytex/busytex_worker.js` (a browser Web
 *              Worker classic script) run inside a plain Node worker thread,
 *              so the compile pipeline can be benchmarked without Electron.
 *
 * Bridges provided (browser → node):
 *   - `self`                    → globalThis alias
 *   - `postMessage(obj)`        → parentPort.postMessage
 *   - `onmessage = fn`          → parentPort 'message' subscription wrapped
 *                                 into `{ data }` events
 *   - `importScripts(src)`      → vm.runInThisContext of the resolved script
 *   - `fetch(url)`              → disk for `scipen-wasm://busytex/<name>`
 *                                 (workerData.variantDir/<name>), native
 *                                 fetch otherwise. Emits `benchRemoteUrl`
 *                                 notifications for remote http(s) URLs so
 *                                 the harness can count on-demand fetches.
 *   - `XMLHttpRequest`          → synchronous GET/HEAD via curl for http(s)
 *                                 (the kpse remote fetcher uses sync XHR),
 *                                 disk read (+ Range support) for
 *                                 scipen-wasm:// — mirroring what the
 *                                 app's scipen-wasm protocol handler does.
 *
 * Set `BENCH_CURL_PROXY` to route curl through a proxy, e.g.
 * `http://127.0.0.1:12334`.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs'; // default export = mutable CJS object, shared with require('node:fs')
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const VARIANT_DIR = workerData.variantDir;
const ASSET_SCHEME = 'scipen-wasm://busytex/';

// ====== self / postMessage / onmessage ======

globalThis.self = globalThis;
globalThis.postMessage = (msg) => parentPort.postMessage(msg);

// The emscripten glue detects Node (process.versions.node) and takes its
// Node branch, which expects CommonJS globals absent inside an ESM worker.
// Satisfy that branch: require for its fs/path imports, and __dirname so
// relative asset lookups land inside the variant directory.
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = VARIANT_DIR;
globalThis.__filename = path.join(VARIANT_DIR, 'busytex.js');

// ====== scipen-wasm asset resolution (disk) ======

function resolveAssetPath(url) {
  if (url.startsWith(ASSET_SCHEME)) {
    const name = url.slice(ASSET_SCHEME.length).split('?')[0];
    return path.join(VARIANT_DIR, name);
  }
  if (!/^[a-z]+:\/\//i.test(url)) {
    // Relative (e.g. busytex_worker.js's importScripts('busytex_pipeline.js'))
    return path.join(VARIANT_DIR, url);
  }
  return null;
}

/**
 * The emscripten glue's Node branch reads data packages with plain
 * fs.readFileSync(urlString). Translate scipen-wasm:// asset URLs to their
 * on-disk variant paths so those reads succeed — mirrors what the app's
 * scipen-wasm protocol handler does for browser fetch/XHR.
 */
function toDiskPath(p) {
  if (typeof p === 'string' && p.startsWith(ASSET_SCHEME)) {
    return path.join(VARIANT_DIR, p.slice(ASSET_SCHEME.length).split('?')[0]);
  }
  return p;
}
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
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function patched(p, ...rest) {
    return orig.call(fs, toDiskPath(p), ...rest);
  };
}

function contentTypeFor(file) {
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.js')) return 'application/javascript';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

// ====== fetch shim ======

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const urlStr = String(url);
  const disk = resolveAssetPath(urlStr);
  if (disk) {
    const body = fs.readFileSync(disk);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentTypeFor(disk) },
    });
  }
  if (/^https?:\/\//i.test(urlStr)) {
    parentPort.postMessage({ benchRemoteUrl: urlStr });
  }
  const next = { ...init };
  delete next.mode; // undici rejects some browser-only modes
  return nativeFetch(urlStr, next);
};

// ====== XMLHttpRequest shim (sync via curl / disk) ======

class XMLHttpRequestShim {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.response = null;
    this.responseText = '';
    this.responseType = '';
    this.timeout = 0;
    this.onload = null;
    this.onerror = null;
    this._method = 'GET';
    this._url = '';
    this._headers = {};
    this._respHeaders = {};
  }

  open(method, url) {
    this._method = String(method).toUpperCase();
    this._url = String(url);
    this.readyState = 1;
  }

  setRequestHeader(k, v) {
    this._headers[String(k).toLowerCase()] = String(v);
  }

  overrideMimeType() {
    /* no-op for binary-safe shims */
  }

  getResponseHeader(name) {
    return this._respHeaders[String(name).toLowerCase()] ?? null;
  }

  send() {
    try {
      const disk = resolveAssetPath(this._url);
      if (disk) {
        this._serveDisk(disk);
      } else {
        this._serveNetwork();
      }
      if (this.onload) this.onload();
    } catch (err) {
      this.status = 0;
      if (this.onerror) this.onerror(err);
    }
  }

  _serveDisk(file) {
    if (this._method === 'HEAD') {
      const size = fs.statSync(file).size;
      this.status = 200;
      this._respHeaders = {
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'content-encoding': 'identity',
      };
      this.response = null;
      this.responseText = '';
      return;
    }

    const buf = fs.readFileSync(file);
    let start = 0;
    let end = buf.length - 1;
    const range = this._headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Number(m[2]);
        this.status = 206;
      }
    } else {
      this.status = 200;
    }
    const slice = buf.subarray(start, end + 1);
    this._respHeaders = {
      'content-length': String(slice.length),
      'accept-ranges': 'bytes',
      'content-encoding': 'identity',
    };
    this._finishBody(slice);
  }

  _serveNetwork() {
    parentPort.postMessage({ benchRemoteUrl: this._url });
    const tmp = `${this._url.replace(/[^a-z0-9]/gi, '_')}.${process.pid}.xhr`;
    const args = [
      '-s',
      '-o',
      tmp,
      '-w',
      '%{http_code}',
      '-X',
      this._method,
      '--max-time',
      '60',
      '-D',
      `${tmp}.hdr`,
    ];
    for (const [k, v] of Object.entries(this._headers)) args.push('-H', `${k}: ${v}`);
    if (process.env.BENCH_CURL_PROXY) {
      args.push('-x', process.env.BENCH_CURL_PROXY);
    }
    args.push(this._url);

    const res = spawnSync('curl', args, { encoding: 'utf8' });
    if (res.status !== 0) {
      this.status = 0;
      return;
    }
    this.status = Number(res.stdout) || 0;
    parentPort.postMessage({ benchRemoteDone: this._url, status: this.status });
    this._respHeaders = {};
    try {
      const raw = fs.readFileSync(`${tmp}.hdr`, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim().toLowerCase();
          this._respHeaders[k] = line.slice(idx + 1).trim();
        }
      }
    } catch {
      /* header dump missing — leave empty */
    }
    const body = this.status > 0 && this.status !== 404 && fs.existsSync(tmp)
      ? fs.readFileSync(tmp)
      : Buffer.alloc(0);
    try {
      fs.unlinkSync(tmp);
      fs.unlinkSync(`${tmp}.hdr`);
    } catch {
      /* best effort */
    }
    this._finishBody(body);
  }

  _finishBody(buf) {
    if (this.responseType === 'arraybuffer') {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      this.response = ab;
      this.responseText = '';
    } else {
      this.response = buf.toString('utf8');
      this.responseText = buf.toString('utf8');
    }
  }
}

globalThis.XMLHttpRequest = XMLHttpRequestShim;

// ====== importScripts ======

globalThis.importScripts = (...srcs) => {
  for (const src of srcs) {
    const file = resolveAssetPath(String(src));
    if (!file) throw new Error(`importScripts: unsupported url ${src}`);
    const code = fs.readFileSync(file, 'utf8');
    vm.runInThisContext(code, { filename: file });
  }
};

// ====== load the BusyTeX worker script, then wire messages ======

const WORKER_FILE = workerData.workerFile
  ? path.resolve(workerData.workerFile)
  : path.join(VARIANT_DIR, 'busytex_worker.js');

vm.runInThisContext(fs.readFileSync(WORKER_FILE, 'utf8'), {
  filename: WORKER_FILE,
});

parentPort.on('message', (data) => {
  // busytex_worker.js's onmessage is async and may reject; surface it.
  Promise.resolve(globalThis.onmessage({ data })).catch((err) => {
    parentPort.postMessage({
      exception: `unhandled: ${err?.stack || err}`,
    });
  });
});

parentPort.postMessage({ benchReady: true });
