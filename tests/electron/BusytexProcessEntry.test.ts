/**
 * Integration tests for the BusyTeX UtilityProcess entry
 * (src/main/busytex-process/index.ts).
 *
 * The entry runs in-process here with a stubbed `process.parentPort` and a
 * fixture assets dir whose busytex_worker.js is a minimal fake. This pins
 * the two failure classes that shipped to users:
 *   1. the load handshake (importScripts → initialized frame → response);
 *   2. the browser shims the vendored pipeline depends on — most notably
 *      `fetch`, which busytex_pipeline.js uses for the wasm binary and every
 *      data package. A missing/unshimmed fetch rejects on the
 *      scipen-wasm:// scheme, the pipeline swallows the rejection, and load
 *      hangs to its 300 s timeout (seen in the packaged app).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { normaliseRoot } from '../../src/main/busytex-process/buildArtifactCache';

/**
 * Controls the stubbed curl. Null = delegate to the real binary, so every
 * pre-existing test keeps its original behaviour.
 */
const curlStub = vi.hoisted(
  () =>
    ({ impl: null }) as {
      impl: null | { exitCode: number; httpCode: string; writeBody: boolean };
    }
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const nodeFs = await import('node:fs');
  /** Honour `-o <path>` only when the scenario says the transfer succeeded. */
  const writeBodyIfAsked = (args: readonly string[]): void => {
    if (!curlStub.impl?.writeBody) return;
    const i = args.indexOf('-o');
    if (i >= 0) nodeFs.writeFileSync(args[i + 1], 'body-bytes');
  };
  return {
    ...actual,
    spawnSync: (cmd: string, args: readonly string[], opts?: unknown) => {
      if (cmd !== 'curl' || !curlStub.impl) {
        return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, args, opts);
      }
      writeBodyIfAsked(args);
      return { status: curlStub.impl.exitCode, stdout: curlStub.impl.httpCode, stderr: '' };
    },
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb: (e: unknown, out: string) => void
    ) => {
      if (cmd !== 'curl' || !curlStub.impl) {
        return (actual.execFile as (...a: unknown[]) => unknown)(cmd, args, opts, cb);
      }
      writeBodyIfAsked(args);
      const { exitCode, httpCode } = curlStub.impl;
      queueMicrotask(() => cb(exitCode === 0 ? null : new Error('curl failed'), httpCode));
      return undefined;
    },
  };
});

type Msg = Record<string, unknown>;

const port = {
  listeners: new Map<string, Set<(ev: { data: Msg }) => void>>(),
  sent: [] as Msg[],
  /** Installed by the entry's top-level `parentPort.on('message', ...)`. */
  dispatch(data: Msg): void {
    for (const cb of this.listeners.get('message') ?? []) cb({ data });
  },
};

const FIXTURE_TEXT = 'hello-from-fetch-shim';

let fixtureDir: string;

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function request(
  id: string,
  method: string,
  params?: unknown
): Promise<{ result?: unknown; error?: { message: string } }> {
  const responses: Msg[] = [];
  const orig = port.sent.length;
  void orig;
  // The response for `id` arrives through postMessage; capture all and pick.
  port.dispatch({ id, type: 'request', method, params });
  await flush();
  return port.sent.find((m) => m.type === 'response' && m.id === id) as {
    result?: unknown;
    error?: { message: string };
  };
}

describe('busytex-process entry', () => {
  beforeEach(async () => {
    port.sent = [];
    port.listeners.clear();
    fixtureDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'busytex-entry-'));
    fs.writeFileSync(
      nodePath.join(fixtureDir, 'manifest.json'),
      JSON.stringify({ preload: ['pkg-preload.js'], catalog: ['pkg-catalog.js'] })
    );
    fs.writeFileSync(nodePath.join(fixtureDir, 'hello.txt'), FIXTURE_TEXT);
    fs.writeFileSync(
      nodePath.join(fixtureDir, 'blank.wasm'),
      Buffer.from([0x00, 0x61, 0x73, 0x6d])
    );
    fs.writeFileSync(nodePath.join(fixtureDir, 'pkg-preload.js'), '// fixture preload');
    fs.writeFileSync(nodePath.join(fixtureDir, 'pkg-catalog.js'), '// fixture catalog');
    // Minimal fake worker: answers the load frame with `initialized`, and a
    // compile frame with the result of fetching scheme URLs via the shim —
    // including the .wasm Content-Type, which WebAssembly.compileStreaming
    // rejects responses over (must be application/wasm).
    fs.writeFileSync(
      nodePath.join(fixtureDir, 'busytex_worker.js'),
      [
        'onmessage = async ({ data }) => {',
        '  if (data.busytex_js !== undefined) {',
        '    postMessage({ initialized: ["fixture"] });',
        '    return;',
        '  }',
        '  if (data.files !== undefined) {',
        // Remote-fetch probes: exercise the two http paths (async fetch shim
        // and the synchronous XHR shim kpathsea uses) against the stubbed curl.
        '    if (data.main_tex_path === "probe-fetch") {',
        '      const rr = await fetch("https://example.invalid/missing.sty");',
        '      postMessage({ exit_code: 0, log: "fetch=" + rr.status });',
        '      return;',
        '    }',
        '    if (data.main_tex_path === "probe-xhr") {',
        '      const xhr = new XMLHttpRequest();',
        '      let outcome = "none";',
        '      xhr.onload = () => { outcome = "load=" + xhr.status; };',
        '      xhr.onerror = () => { outcome = "error"; };',
        '      xhr.open("GET", "https://example.invalid/missing.sty");',
        '      xhr.send();',
        '      postMessage({ exit_code: 0, log: "xhr=" + outcome });',
        '      return;',
        '    }',
        '    const r = await fetch("scipen-wasm://busytex/hello.txt");',
        '    const w = await fetch("scipen-wasm://busytex/blank.wasm");',
        '    const bin = (data.files || []).filter((f) => typeof f.contents !== "string");',
        '    const log = (await r.text()) + "|" + w.headers.get("content-type") +',
        '      (bin.length ? "|bin" + bin.map((b) => b.contents.length).join(",") : "");',
        '    postMessage({ exit_code: 0, log, ok: r.ok, status: r.status });',
        '  }',
        '};',
        '',
      ].join('\n')
    );

    process.env.WASM_ASSETS_DIR = fixtureDir;
    process.env.TEXLIVE_CACHE_DIR = nodePath.join(fixtureDir, 'cache');
    process.env.BUSYTEX_BUILD_CACHE_DIR = nodePath.join(fixtureDir, 'build-cache');
    Object.defineProperty(process, 'parentPort', {
      value: {
        on: (ev: string, cb: (e: { data: Msg }) => void) => {
          if (!port.listeners.has(ev)) port.listeners.set(ev, new Set());
          port.listeners.get(ev)!.add(cb);
        },
        postMessage: (msg: Msg) => {
          port.sent.push(msg);
        },
      },
      configurable: true,
    });
    vi.resetModules();
    await import('../../src/main/busytex-process/index');
    await flush();
  });

  afterEach(() => {
    // Remove, not blank: process.env coerces `undefined` to the string "undefined".
    Reflect.deleteProperty(process, 'parentPort');
    for (const key of ['WASM_ASSETS_DIR', 'TEXLIVE_CACHE_DIR', 'BUSYTEX_BUILD_CACHE_DIR']) {
      Reflect.deleteProperty(process.env, key);
    }
    curlStub.impl = null;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Files the cache layer considers real entries (vs in-flight transfers). */
  function cacheEntries(suffix: '.bin' | '.miss'): string[] {
    const dir = nodePath.join(fixtureDir, 'cache');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => new RegExp(`^[0-9a-f]{64}\\${suffix}$`).test(f));
  }

  /**
   * Compile request in the current wire shape. Without `projectRoot` the
   * engine stages only the buffer, under the main file's base name — which
   * is how the fixture worker's probe branches are selected.
   */
  function compileParams(main = 'main.tex', overrides: Record<string, unknown> = {}) {
    const abs = nodePath.join(fixtureDir, 'proj', main);
    return {
      mainFileAbs: abs,
      overlay: { absPath: abs, contents: 'x' },
      driver: 'pdftex',
      endpoint: '',
      outputDir: fixtureDir,
      baseName: 'main',
      ...overrides,
    };
  }

  async function compileProbe(id: string, probe: 'probe-fetch' | 'probe-xhr'): Promise<void> {
    await request(`${id}-load`, 'load');
    await request(
      id,
      'compile',
      compileParams(probe, {
        driver: 'pdftex_bibtex8',
        endpoint: 'https://example.invalid',
        outputDir: nodePath.join(fixtureDir, 'out'),
      })
    );
  }

  it('does not cache a 200 whose body could not be read back (fetch path)', async () => {
    // curl claims success but the transfer file is missing — disk full, AV
    // quarantine, or a concurrent cache cleanup. Storing the empty buffer as
    // a 200 would create a permanent poison entry: `.bin` has no TTL, no
    // length check and no eviction on this path.
    curlStub.impl = { exitCode: 0, httpCode: '200', writeBody: false };
    await compileProbe('poison-fetch', 'probe-fetch');

    expect(cacheEntries('.bin')).toHaveLength(0);
    expect(cacheEntries('.miss')).toHaveLength(0);
  });

  it('does not cache a 200 whose body could not be read back (sync XHR path)', async () => {
    curlStub.impl = { exitCode: 0, httpCode: '200', writeBody: false };
    await compileProbe('poison-xhr', 'probe-xhr');

    expect(cacheEntries('.bin')).toHaveLength(0);
    // The request must surface as a failure, not a silent empty success.
    const frame = port.sent.find((m) => m.type === 'response' && m.id === 'poison-xhr') as
      | { result?: { log?: string } }
      | undefined;
    expect(frame?.result?.log).toContain('error');
  });

  it('still caches a 200 when the body is actually there', async () => {
    curlStub.impl = { exitCode: 0, httpCode: '200', writeBody: true };
    await compileProbe('good-fetch', 'probe-fetch');

    expect(cacheEntries('.bin')).toHaveLength(1);
  });

  it('records a 404 probe as a miss marker', async () => {
    curlStub.impl = { exitCode: 0, httpCode: '404', writeBody: false };
    await compileProbe('miss-fetch', 'probe-fetch');

    expect(cacheEntries('.miss')).toHaveLength(1);
    expect(cacheEntries('.bin')).toHaveLength(0);
  });

  it('serves a stale miss marker without re-probing — misses never expire', async () => {
    // Written by the main-process cache layout, read by the engine's own
    // synchronous copy: the two implementations must stay in lockstep.
    const url = 'https://example.invalid/missing.sty';
    const crypto = await import('node:crypto');
    const key = crypto.createHash('sha256').update(url).digest('hex');
    const dir = nodePath.join(fixtureDir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const marker = nodePath.join(dir, `${key}.miss`);
    fs.writeFileSync(marker, '');
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(marker, past, past);

    // Any curl call here would be a bug — the marker must answer on its own.
    curlStub.impl = { exitCode: 1, httpCode: '0', writeBody: false };
    await compileProbe('stale-miss', 'probe-fetch');

    const frame = port.sent.find((m) => m.type === 'response' && m.id === 'stale-miss') as
      | { result?: { log?: string } }
      | undefined;
    expect(frame?.result?.log).toBe('fetch=404');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('announces ready and completes the load handshake', async () => {
    expect(port.sent.some((m) => m.type === 'event' && m.event === 'ready')).toBe(true);

    const res = await request('req-1', 'load');
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ loaded: true });
  });

  it('serves scipen-wasm:// assets through the fetch shim', async () => {
    await request('req-1', 'load');

    // The fake worker fetches scipen-wasm://busytex/hello.txt during the
    // compile frame and returns the body in `log` — proving the fetch shim
    // resolved the scheme, produced ok/status, and handed over the bytes.
    const res = (await request('req-2', 'compile', compileParams())) as {
      result?: { exitCode: number; log: string };
    };
    expect(res.error).toBeUndefined();
    expect(res.result?.exitCode).toBe(0);
    // Body bytes flow through, and the wasm response carries the MIME type
    // compileStreaming demands.
    expect(res.result?.log).toBe(`${FIXTURE_TEXT}|application/wasm`);
  });

  it('caches load as a single attempt per process lifetime', async () => {
    await request('req-1', 'load');
    const res = await request('req-2', 'load');
    // Idempotent: second load hits the pipelineReady fast path.
    expect(res.result).toEqual({ loaded: true });
  });

  it('stages figures from the project directory as real bytes', async () => {
    // The engine reads the project itself; a figure must reach the worker as
    // binary (no base64 hop), with the editor buffer standing in for main.tex.
    const projectRoot = nodePath.join(fixtureDir, 'proj');
    fs.mkdirSync(nodePath.join(projectRoot, 'images'), { recursive: true });
    fs.writeFileSync(nodePath.join(projectRoot, 'images', 'pic.jpg'), Buffer.from('ABC图片')); // allow-cjk: multi-byte payload
    await request('req-1', 'load');
    const res = (await request('req-2', 'compile', compileParams('main.tex', { projectRoot }))) as {
      result?: { exitCode: number; log: string };
    };
    expect(res.error).toBeUndefined();
    // 3 ASCII bytes + 2 CJK characters × 3 UTF-8 bytes = 9 bytes, delivered as binary.
    expect(res.result?.log).toBe(`${FIXTURE_TEXT}|application/wasm|bin9`);
  });

  it('refuses a second concurrent call instead of clobbering the first', async () => {
    // Regression: the worker has a single pending-call slot; a second
    // concurrent request used to overwrite the first's pendingFrame — the
    // first caller hung to its timeout and print attribution crossed.
    await request('req-1', 'load');
    const params = compileParams();
    // Dispatch both back-to-back without awaiting the first.
    port.dispatch({ id: 'c1', type: 'request', method: 'compile', params });
    port.dispatch({ id: 'c2', type: 'request', method: 'compile', params });
    await flush();

    const r1 = port.sent.find((m) => m.type === 'response' && m.id === 'c1') as Msg;
    const r2 = port.sent.find((m) => m.type === 'response' && m.id === 'c2') as Msg;
    expect(r1?.result).toMatchObject({ exitCode: 0 });
    expect(r2?.error?.message).toMatch(/engine busy/);
  });

  it('mounts the catalog packages a project used last time at load', async () => {
    // Recorded by an earlier compile of this project; only catalog members
    // are honoured, so a stray entry cannot make the engine fetch anything.
    const projectRoot = nodePath.join(fixtureDir, 'proj');
    const buildCache = nodePath.join(fixtureDir, 'build-cache');
    fs.mkdirSync(buildCache, { recursive: true });
    fs.writeFileSync(
      nodePath.join(buildCache, 'warm-packages.json'),
      JSON.stringify({
        [normaliseRoot(projectRoot)]: [
          'scipen-wasm://busytex/pkg-catalog.js',
          'scipen-wasm://busytex/not-in-manifest.js',
        ],
      })
    );

    await request('req-1', 'load', { projectRoot });
    const stats = port.sent.find(
      (m) => m.type === 'event' && m.event === 'stats' && (m.data as Msg).phase === 'load'
    )?.data as { dataPackages?: string[] };

    expect(stats.dataPackages).toEqual([
      'scipen-wasm://busytex/pkg-preload.js',
      'scipen-wasm://busytex/pkg-catalog.js',
    ]);
  });

  it('answers clearBuildCache so a running engine drops its in-memory copy', async () => {
    await request('req-1', 'load');
    await request('req-2', 'compile', compileParams());
    const res = await request('req-3', 'clearBuildCache');

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ removed: expect.any(Number) });
  });

  it('persists the TeX log next to the output even when no PDF was produced', async () => {
    // The WASM log used to live only in memory, so a partial or missing PDF
    // could not be diagnosed after the fact. The fixture worker returns a log
    // but no PDF — exactly the case where the log matters most.
    await request('req-1', 'load');
    const outputDir = nodePath.join(fixtureDir, 'out');
    const res = (await request('req-2', 'compile', compileParams('main.tex', { outputDir }))) as {
      result?: { pdfPath?: string; log: string };
    };

    expect(res.result?.pdfPath).toBeUndefined();
    const logPath = nodePath.join(outputDir, 'main.log');
    expect(fs.readFileSync(logPath, 'utf8')).toBe(res.result?.log);
  });
});
