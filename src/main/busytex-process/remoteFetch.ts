/**
 * @file busytex-process/remoteFetch.ts — fetch / XHR shims with the TeX Live cache
 *
 * The pipeline loads its wasm and data packages with `fetch()`, and kpathsea
 * pulls on-demand TeX Live files with synchronous XHR. Both resolve
 * `scipen-wasm://` URLs from disk and send http(s) through curl backed by
 * the on-disk cache shared with the main process (TexliveRemoteCache uses
 * the same sha256-URL layout, so entries written by either side are hits for
 * both).
 */

import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import * as nodePath from 'node:path';
import { browserGlobals } from './browserShims';
import { stats } from './engineStats';
import { SYNC_FETCH_TIMEOUT_S, TEXLIVE_CACHE_DIR, WASM_ASSETS_DIR, resolveAssetPath } from './env';

const DEFAULT_SNAPSHOT_HOST = 'texlive2026.texlyre.org';
const BUILD_ARTIFACT_RE =
  /\.(aux|toc|out|lof|lot|nav|snm|vrb|bbl|blg|idx|ind|ilg|log|fls|fdb_latexmk|xdv|pdf|bcf|run\.xml|synctex\.gz)$/i;
const BUNDLED_FANDOL_FONTSPEC_MISSES = new Set([
  'fandolsong-regular.fontspec',
  'fandolsong-bold.fontspec',
  'fandolhei-regular.fontspec',
  'fandolhei-bold.fontspec',
  'fandolkai-regular.fontspec',
  'fandolfang-regular.fontspec',
]);
const SNAPSHOT_OPTIONAL_SIDECAR_MISSES = new Set([
  'hyperref.cfg',
  'rerunfilecheck.cfg',
  'gettitlestring.cfg',
  'pd1enc.dfu',
  'puenc.dfu',
]);

/**
 * Identify remote probes guaranteed to 404 on the pinned TeX Live 2026
 * snapshot (`https://texlive2026.texlyre.org` on the default HTTPS port).
 * Strictly scoped to that host/protocol/port so user-configured mirrors are
 * never short-circuited.
 */
export function isGuaranteedRemoteMiss(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== DEFAULT_SNAPSHOT_HOST ||
    (parsed.port !== '' && parsed.port !== '443')
  ) {
    return false;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return false;
  let name: string;
  try {
    name = decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return false;
  }
  const format = segments[segments.length - 2];
  if (!/^\d+$/.test(format) || !name) return false;

  if (BUILD_ARTIFACT_RE.test(name)) return true;
  const lower = name.toLowerCase();
  if (format === '26') {
    if (BUNDLED_FANDOL_FONTSPEC_MISSES.has(lower)) return true;
    if (SNAPSHOT_OPTIONAL_SIDECAR_MISSES.has(lower)) return true;
  }
  if (format === '20' && /^cm[a-z]+\d+\.ofm$/i.test(name)) return true;
  if (format === '33' && /^cm[a-z]+\d+\.vf$/i.test(name)) return true;
  if ((format === '39' || format === '45') && /^cm[a-z]+\d+$/i.test(name)) return true;
  return false;
}

/**
 * Counted wrapper around {@link lookupCacheEntry}. Lookups are themselves an
 * IO cost worth measuring: each one is a `stat` plus (on a hit) a full read,
 * and on Windows every one of those is an AV-scanned file operation.
 */
function cacheLookup(url: string): { status: 200 | 404; body: Buffer } | null {
  const t0 = performance.now();
  try {
    const hit = lookupCacheEntry(url);
    if (hit) stats.cacheHits += 1;
    return hit;
  } finally {
    stats.cacheMs += performance.now() - t0;
  }
}

/** Synchronous cache lookup mirroring TexliveRemoteCache's on-disk layout. */
function lookupCacheEntry(url: string): { status: 200 | 404; body: Buffer } | null {
  if (!TEXLIVE_CACHE_DIR) return null;
  const key = crypto.createHash('sha256').update(url).digest('hex');
  const missPath = nodePath.join(TEXLIVE_CACHE_DIR, `${key}.miss`);
  const contentPath = nodePath.join(TEXLIVE_CACHE_DIR, `${key}.bin`);
  try {
    // Misses never expire, exactly like the 200s next to them: the endpoint
    // serves an immutable TeX Live snapshot (`texlive2026.…`), and a snapshot
    // that lacks a file today will not grow one tomorrow. A different mirror
    // or release is a different URL, hence a different key, so switching is
    // already isolated. Kept in lockstep with TexliveRemoteCache.get().
    if (fs.existsSync(missPath)) {
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
        const body = fs.readFileSync(disk);
        stats.diskReads += 1;
        stats.diskBytes += body.byteLength;
        this.status = 200;
        this.finish(body);
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
        if (isGuaranteedRemoteMiss(this.url)) {
          this.status = 404;
          this.finish(Buffer.alloc(0));
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
        const curlT0 = performance.now();
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
        stats.curlMs += performance.now() - curlT0;
        if (res.status !== 0) {
          stats.fetchErrors += 1;
          this.status = 0;
          this.onerror?.(new Error(res.stderr || 'curl failed'));
          return;
        }
        this.status = Number(res.stdout) || 0;
        // "curl reported 200" is NOT enough to cache: the body lands in a temp
        // file inside the cache dir, and if that file cannot be read back
        // (disk full, AV quarantine, a concurrent cache cleanup) the old code
        // silently substituted an empty Buffer and stored it as a 200. A `.bin`
        // has no TTL, no length check and no eviction, so that empty entry
        // became a PERMANENT poison pill served to every later compile.
        // Rule: no bytes read back => not a 200.
        let body = Buffer.alloc(0);
        let readOk = false;
        if (this.status > 0 && this.status !== 404) {
          try {
            body = fs.readFileSync(tmp);
            readOk = true;
          } catch {
            readOk = false;
          }
        }
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        if (this.status === 200 && !readOk) {
          stats.fetchErrors += 1;
          this.status = 0;
          this.onerror?.(new Error('curl reported 200 but the response body was lost'));
          return;
        }
        if (this.status === 200) {
          stats.fetched200 += 1;
          stats.fetchedBytes += body.byteLength;
          cacheStore(this.url, body, false);
        } else if (this.status === 404) {
          stats.fetched404 += 1;
          cacheStore(this.url, Buffer.alloc(0), true);
        } else {
          stats.fetchErrors += 1;
        }
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
    if (isGuaranteedRemoteMiss(url)) {
      resolve({ status: 404, body: Buffer.alloc(0) });
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
    const curlT0 = performance.now();
    childProcess.execFile(
      'curl',
      ['-s', '-o', tmp, '-w', '%{http_code}', '-X', method, '--max-time', String(timeoutS), url],
      { encoding: 'utf8', timeout: (timeoutS + 5) * 1000 },
      (err, stdout) => {
        stats.curlMs += performance.now() - curlT0;
        const rawStatus = err ? 0 : Number(stdout) || 0;
        // Same poison-pill guard as the synchronous shim above: a 200 whose
        // body cannot be read back must NOT be cached, or the empty buffer
        // becomes a permanent `.bin`. Degrade to 502 so the caller retries.
        let body = Buffer.alloc(0);
        let readOk = false;
        if (rawStatus === 200) {
          try {
            body = fs.readFileSync(tmp);
            readOk = true;
          } catch {
            readOk = false;
          }
        }
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        if (rawStatus === 200 && !readOk) {
          stats.fetchErrors += 1;
          resolve({ status: 502, body: Buffer.alloc(0) });
          return;
        }
        if (rawStatus === 200) {
          stats.fetched200 += 1;
          stats.fetchedBytes += body.byteLength;
          cacheStore(url, body, false);
        } else if (rawStatus === 404) {
          stats.fetched404 += 1;
          cacheStore(url, Buffer.alloc(0), true);
        } else {
          stats.fetchErrors += 1;
        }
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
    // This is the ~120 MB wasm + data-package path, so it dominates `load`.
    const body = fs.readFileSync(disk);
    stats.diskReads += 1;
    stats.diskBytes += body.byteLength;
    // Content-Type matters: WebAssembly.compileStreaming rejects any
    // response whose MIME type is not application/wasm.
    return new Response(body, {
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

export function installNetworkShims(): void {
  browserGlobals.XMLHttpRequest = XMLHttpRequestShim;
  browserGlobals.fetch = fetchShim as unknown as typeof fetch;
}
