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
    delete (process as { parentPort?: unknown }).parentPort;
    delete process.env.WASM_ASSETS_DIR;
    delete process.env.TEXLIVE_CACHE_DIR;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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
    const res = (await request('req-2', 'compile', {
      files: [{ path: 'main.tex', contents: 'x' }],
      mainFile: 'main.tex',
      driver: 'pdftex',
      endpoint: '',
      outputDir: fixtureDir,
      baseName: 'main',
    })) as { result?: { exitCode: number; log: string } };
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

  it('delivers base64-encoded files to the worker as real bytes', async () => {
    // Gap 1: figures travel base64 over IPC; handleCompile must decode them
    // before the VFS write — the worker sees a Uint8Array of decoded bytes.
    await request('req-1', 'load');
    const res = (await request('req-2', 'compile', {
      files: [
        { path: 'main.tex', contents: 'x' },
        {
          path: 'images/pic.jpg',
          contents: Buffer.from('ABC图片').toString('base64'),
          encoding: 'base64',
        },
      ],
      mainFile: 'main.tex',
      driver: 'pdftex',
      endpoint: '',
      outputDir: fixtureDir,
      baseName: 'main',
    })) as { result?: { exitCode: number; log: string } };
    expect(res.error).toBeUndefined();
    // 'ABC图片' = 3 + 6 utf8 bytes = 9 bytes, delivered as binary.
    expect(res.result?.log).toBe(FIXTURE_TEXT + '|application/wasm|bin9');
  });

  it('refuses a second concurrent call instead of clobbering the first', async () => {
    // Regression: the worker has a single pending-call slot; a second
    // concurrent request used to overwrite the first's pendingFrame — the
    // first caller hung to its timeout and print attribution crossed.
    await request('req-1', 'load');
    const compileParams = {
      files: [{ path: 'main.tex', contents: 'x' }],
      mainFile: 'main.tex',
      driver: 'pdftex',
      endpoint: '',
      outputDir: fixtureDir,
      baseName: 'main',
    };
    // Dispatch both back-to-back without awaiting the first.
    port.dispatch({ id: 'c1', type: 'request', method: 'compile', params: compileParams });
    port.dispatch({ id: 'c2', type: 'request', method: 'compile', params: compileParams });
    await flush();

    const r1 = port.sent.find((m) => m.type === 'response' && m.id === 'c1') as Msg;
    const r2 = port.sent.find((m) => m.type === 'response' && m.id === 'c2') as Msg;
    expect(r1?.result).toMatchObject({ exitCode: 0 });
    expect(r2?.error?.message).toMatch(/engine busy/);
  });
});
