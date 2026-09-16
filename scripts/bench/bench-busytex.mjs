/**
 * @file bench-busytex.mjs - A/B benchmark for the BusyTeX performance fixes
 * @description Compares two variants of the vendored BusyTeX pipeline:
 *
 *   baseline — pristine upstream `busytex_pipeline.js` (extracted from the
 *              cached texlyre tarball into .bench-tmp/variant-baseline/)
 *   patched  — `public/wasm/busytex/` as shipped after our rerun-skip patch
 *
 * Scenario 1 (offline, pass-schedule fix):
 *   docA (plain article, no toc/refs) on pdftex + xetex drivers, and
 *   docB (toc + labels + bibliography) on xetex. Warm compiles only —
 *   the first compile per worker absorbs TeX Live data-package loading and
 *   is identical in both variants by construction.
 *   Validates: warm wall time AND `$ busytex` command counts AND normalized
 *   PDF equality between variants.
 *
 * Scenario 2 (remote, CJK on-demand fetch fix):
 *   docC (`\usepackage{ctex}`, Chinese text, xetex) compiled in a FRESH
 *   worker per run — simulating app relaunch / post-cancel cold start,
 *   because upstream only caches fetched TeX files in worker memory.
 *     baseline run: remote_endpoint = https://texlive2026.texlyre.org (direct)
 *     cached   run: remote_endpoint = local proxy backed by the REAL
 *                   TexliveRemoteCache module (src/main/services/*.ts) with
 *                   the same semantics as WasmAssetProtocol.handleTexliveRemote.
 *   Run 1 = cold cache (proxy stores while serving); run 2 = warm disk cache.
 *   The headline comparison is baseline run 2 vs cached run 2 — both are
 *   "second app launch" cold starts, one re-downloads, one hits disk.
 *
 * Usage:
 *   node scripts/bench/bench-busytex.mjs [--samples N] [--skip-remote]
 *        [--only passes|remote]
 *
 * Output: markdown table to stdout + .bench-tmp/bench-report.{md,json}
 */

import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as zl from 'node:zlib';

import { fileURLToPath } from 'node:url';
// Node 24 type-stripping: importing the real cache module keeps the proxy
// semantics (keying, 404 TTL, LRU) identical to production.
import { TexliveRemoteCache } from '../../src/main/services/TexliveRemoteCache.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BENCH_TMP = path.join(ROOT, '.bench-tmp');
const SHIM = path.join(__dirname, 'worker-shim.mjs');
const PATCHED_DIR = path.join(ROOT, 'public', 'wasm', 'busytex');
const BASELINE_DIR = path.join(BENCH_TMP, 'variant-baseline');
const TARBALL = path.join(ROOT, '.busytex-cache', 'busytex-assets-v1.1.1.tar.gz');
const DEFAULT_ENDPOINT = 'https://texlive2026.texlyre.org';

const args = process.argv.slice(2);
const SAMPLES = Number(args[args.indexOf('--samples') + 1] ?? 3) || 3;
const SKIP_REMOTE = args.includes('--skip-remote');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

// ====== Benchmark documents ======

const DOC_A = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\title{Benchmark Document A}
\author{SciPen Bench}
\date{2026-09-13}
\maketitle
\section{Introduction}
This is a plain document with no table of contents, no labels, and no
citations, so a single typesetting pass produces stable output.
\section{Equations}
The mass--energy equivalence $E = mc^2$ and a displayed equation:
\begin{equation}
  \int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}.
\end{equation}
\end{document}
`;

const DOC_B_FILES = [
  {
    path: 'main.tex',
    contents: String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{hyperref}
\begin{document}
\tableofcontents
\section{Introduction}\label{sec:intro}
As shown in Section~\ref{sec:method}, the method of~\cite{knuth1984}
applies. See also Equation~\eqref{eq:euler}.
\section{Method}\label{sec:method}
We follow the approach of~\cite{lamport1994}.
\begin{equation}\label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
\section{Conclusion}
Cross-references resolve after reruns, exercising the rerun ladder.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
  },
  {
    path: 'refs.bib',
    contents: String.raw`@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The TeXbook},
  year = {1984},
  publisher = {Addison-Wesley},
}
@book{lamport1994,
  author = {Lamport, Leslie},
  title = {LaTeX: A Document Preparation System},
  year = {1994},
  publisher = {Addison-Wesley},
}
`,
  },
];

const DOC_C = String.raw`\documentclass{article}
\usepackage{ctex}
\usepackage{amsmath}
\begin{document}
\section{引言}
本文档用于测试中文排版在 BusyTeX WebAssembly 引擎下的按需宏包获取性能。
ctex 宏包与其依赖不在本地数据包中,需要从远程 TeX Live 端点逐个获取。
\section{方法}
中文与数学混排测试:$E = mc^2$,以及显示公式:
\begin{equation}
  \int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}.
\end{equation}
\section{结论}
第二次编译应当命中磁盘缓存,从而避免重复下载。
\end{document}
`;

// ====== Worker wrapper ======

class BenchWorker {
  constructor(variantDir) {
    this.remote = { requests: 0, ok: 0, miss404: 0, errors: 0 };
    this.worker = new Worker(SHIM, { workerData: { variantDir } });
    this.worker.unref?.();
  }

  onNotify(msg) {
    if (msg.benchRemoteUrl) this.remote.requests += 1;
    if (msg.benchRemoteDone) {
      if (msg.status === 200) this.remote.ok += 1;
      else if (msg.status === 404) this.remote.miss404 += 1;
      else this.remote.errors += 1;
    }
  }

  /** Post the engine-init handshake, wait for `initialized`. */
  init(timeoutMs = 300_000) {
    const t0 = performance.now();
    return this._await(
      () => {
        this.worker.postMessage({
          busytex_js: 'scipen-wasm://busytex/busytex.js',
          busytex_wasm: 'scipen-wasm://busytex/busytex.wasm',
          preload_data_packages_js: ['scipen-wasm://busytex/texlive-basic.js'],
          data_packages_js: ['scipen-wasm://busytex/texlive-extra.js'],
          texmf_local: [],
          preload: true,
        });
      },
      (msg) => msg.initialized !== undefined || msg.exception !== undefined,
      timeoutMs,
      'engine init'
    ).then((r) => {
      if (r.exception) throw new Error(`init failed: ${r.exception}`);
      return Math.round(performance.now() - t0);
    });
  }

  compile(files, mainTex, driver, remoteEndpoint, timeoutMs = 900_000) {
    const t0 = performance.now();
    return this._await(
      () => {
        this.worker.postMessage({
          files,
          main_tex_path: mainTex,
          bibtex: null,
          makeindex: null,
          rerun: null,
          verbose: 'silent',
          driver,
          data_packages_js: null,
          remote_endpoint: remoteEndpoint,
        });
      },
      (msg) =>
        msg.exception !== undefined ||
        msg.exit_code !== undefined ||
        msg.pdf !== undefined,
      timeoutMs,
      'compile'
    ).then((msg) => {
      const ms = Math.round(performance.now() - t0);
      if (msg.exception) throw new Error(`compile failed: ${msg.exception}`);
      return {
        ms,
        exitCode: msg.exit_code ?? -1,
        log: msg.log ?? '',
        cmds: (msg.logs ?? []).map((e) => e.cmd),
        pdf: msg.pdf ? Buffer.from(msg.pdf) : null,
        synctex: msg.synctex ? Buffer.from(msg.synctex) : null,
      };
    });
  }

  _await(start, isTerminal, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      const onMessage = (msg) => {
        this.onNotify(msg);
        if (msg.print !== undefined) {
          if (String(msg.print).startsWith('$')) console.log(`    [worker] ${msg.print}`);
          return;
        }
        if (!isTerminal(msg)) return;
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        resolve(msg);
      };
      this.worker.on('message', onMessage);
      this.worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      start();
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

// ====== Variant preparation ======

function prepareBaselineDir() {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  // Hardlink every patched-side asset (zero copy), then swap in the pristine
  // upstream pipeline extracted from the cached tarball.
  for (const name of fs.readdirSync(PATCHED_DIR)) {
    const dst = path.join(BASELINE_DIR, name);
    fs.rmSync(dst, { force: true });
    fs.linkSync(path.join(PATCHED_DIR, name), dst);
  }
  fs.rmSync(path.join(BASELINE_DIR, 'busytex_pipeline.js'));
  const upstream = fs.readFileSync(path.join(BENCH_TMP, 'busytex_pipeline.upstream.js'));
  fs.writeFileSync(path.join(BASELINE_DIR, 'busytex_pipeline.js'), upstream);
}

// ====== Scenario 1: warm compile pass schedule ======

/**
 * Content-level PDF equivalence hash.
 *
 * xdvipdfmx output is inherently NON-deterministic, in three places:
 *   1. trailer /ID — time-seeded (normalized in the raw header)
 *   2. the XMP metadata packet stream — fresh uuid DocumentID + event
 *      timestamps per run (whole stream dropped when detected)
 *   3. inside xdvipdfmx's compressed object stream: /CreationDate(D:...,
 *      second resolution) and /Creator( XeTeX output YYYY.MM.DD:HHMM)
 *      (regex-normalized after inflation)
 *
 * Verified empirically: after 1–3 are normalized, two compiles of the SAME
 * variant hash identically. Equal hashes ⇒ identical typeset content.
 */
function normalizedPdfHash(pdf) {
  const raw = pdf.toString('latin1').replace(/\/ID\s*\[[^\]]*\]/g, '/ID[X]');
  const parts = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    // A match inside 'endstream\n' is the substring 'stream\n' — skip it.
    if (m.index >= 3 && raw.slice(m.index - 3, m.index) === 'end') {
      streamRe.lastIndex = m.index + 3;
      continue;
    }
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    streamRe.lastIndex = end + 'endstream'.length;
    const chunk = Buffer.from(raw.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    let dec;
    try {
      dec = zl.inflateSync(chunk);
    } catch {
      dec = chunk; // not flate-compressed — compare raw
    }
    if (dec.includes('uuid:') || dec.includes('xmpmeta')) continue; // XMP packet
    const norm = dec
      .toString('latin1')
      .replace(/D:\d{10,14}([+-]\d{2}'\d{2}')?/g, 'D:X')
      .replace(/XeTeX output \d{4}\.\d{2}\.\d{2}:\d{4}/g, 'XeTeX output X');
    parts.push(Buffer.from(norm, 'latin1'));
  }
  const head = raw.slice(0, raw.indexOf('stream'));
  return crypto.createHash('sha256').update(head).update(Buffer.concat(parts)).digest('hex').slice(0, 16);
}

async function runPassesScenario() {
  const configs = [
    { name: 'docA-pdftex', files: [{ path: 'main.tex', contents: DOC_A }], driver: 'pdftex_bibtex8' },
    { name: 'docA-xetex', files: [{ path: 'main.tex', contents: DOC_A }], driver: 'xetex_bibtex8_dvipdfmx' },
    { name: 'docA-lualatex', files: [{ path: 'main.tex', contents: DOC_A }], driver: 'luahbtex_bibtex8' },
    { name: 'docB-xetex', files: DOC_B_FILES, driver: 'xetex_bibtex8_dvipdfmx' },
  ];

  const results = {};
  for (const variant of ['baseline', 'patched']) {
    for (const cfg of configs) {
      const dir = variant === 'patched' ? PATCHED_DIR : BASELINE_DIR;
      const w = new BenchWorker(dir);
      const key = `${cfg.name} [${variant}]`;
      try {
        await w.init();
        // Warmup: absorbs any data-package loading; identical across variants.
        await w.compile(cfg.files, 'main.tex', cfg.driver);
        const samples = [];
        let last = null;
        for (let i = 0; i < SAMPLES; i++) {
          last = await w.compile(cfg.files, 'main.tex', cfg.driver);
          samples.push(last.ms);
          if (last.exitCode !== 0) break;
        }
        samples.sort((a, b) => a - b);
        results[key] = {
          variant,
          medianMs: samples[Math.floor(samples.length / 2)],
          minMs: samples[0],
          samples,
          exitCode: last.exitCode,
          passCount: last.cmds.filter((c) => /^(pdflatex|xelatex|luahblatex|lualatex) /.test(c)).length,
          cmds: last.cmds,
          pdfBytes: last.pdf?.byteLength ?? 0,
          pdfHash: last.pdf ? normalizedPdfHash(last.pdf) : null,
          hasSynctex: !!last.synctex?.byteLength,
        };
        if (last.pdf) {
          const artDir = path.join(BENCH_TMP, 'artifacts');
          fs.mkdirSync(artDir, { recursive: true });
          fs.writeFileSync(path.join(artDir, `${cfg.name}.${variant}.pdf`), last.pdf);
        }
        console.log(
          `  ${key}: median ${results[key].medianMs}ms, passes ${results[key].passCount}, exit ${last.exitCode}, pdf ${results[key].pdfBytes}B hash ${results[key].pdfHash}`
        );
      } finally {
        w.terminate();
      }
    }
  }

  // Drift check: re-run one baseline config after everything.
  const driftKey = 'docA-xetex [baseline]';
  const dw = new BenchWorker(BASELINE_DIR);
  await dw.init();
  await dw.compile([{ path: 'main.tex', contents: DOC_A }], 'main.tex', 'xetex_bibtex8_dvipdfmx');
  const drift = await dw.compile([{ path: 'main.tex', contents: DOC_A }], 'main.tex', 'xetex_bibtex8_dvipdfmx');
  dw.terminate();
  const driftDelta =
    Math.abs(drift.ms - results[driftKey].medianMs) / results[driftKey].medianMs;
  console.log(`  drift check (${driftKey} rerun): ${drift.ms}ms (${(driftDelta * 100).toFixed(1)}% off median)`);

  // Equivalence assertions.
  const equiv = [];
  for (const cfg of configs) {
    const b = results[`${cfg.name} [baseline]`];
    const p = results[`${cfg.name} [patched]`];
    equiv.push({
      config: cfg.name,
      pdfIdentical: b.pdfHash === p.pdfHash && b.pdfHash !== null,
      baselinePasses: b.passCount,
      patchedPasses: p.passCount,
      bothOk: b.exitCode === 0 && p.exitCode === 0,
      synctexBoth: b.hasSynctex === p.hasSynctex,
    });
  }
  return { results, equivalence: equiv, driftPct: +(driftDelta * 100).toFixed(1) };
}

// ====== Scenario 2: CJK remote cold start ======

async function runRemoteScenario() {
  const files = [{ path: 'main.tex', contents: DOC_C }];
  const driver = 'xetex_bibtex8_dvipdfmx';

  // Local proxy backed by the real TexliveRemoteCache — mirrors
  // handleTexliveRemote semantics (200 cached forever, 404 cached with TTL,
  // 5xx never cached → 502).
  const cacheDir = path.join(BENCH_TMP, 'texlive-cache');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const cache = new TexliveRemoteCache({ cacheDir });

  const server = http.createServer(async (req, res) => {
    const remoteUrl = `${DEFAULT_ENDPOINT}${req.url}`;
    try {
      const hit = await cache.get(remoteUrl);
      if (hit) {
        res.writeHead(hit.status, { 'Content-Type': 'application/octet-stream' });
        res.end(hit.body ?? '');
        return;
      }
      const upstream = await fetch(remoteUrl);
      if (upstream.status === 200) {
        const body = Buffer.from(await upstream.arrayBuffer());
        await cache.put(remoteUrl, body);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
        return;
      }
      if (upstream.status === 404) await cache.putMiss(remoteUrl);
      res.writeHead(upstream.status, {});
      res.end();
    } catch {
      res.writeHead(502, {});
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const out = {};
  try {
    // Baseline: direct endpoint, fresh worker per run (app-relaunch semantics).
    for (const run of [1, 2]) {
      const w = new BenchWorker(BASELINE_DIR);
      await w.init();
      const r = await w.compile(files, 'main.tex', driver, DEFAULT_ENDPOINT);
      out[`baseline-run${run}`] = {
        ms: r.ms,
        exitCode: r.exitCode,
        remote: { ...w.remote },
        pdfBytes: r.pdf?.byteLength ?? 0,
      };
      w.terminate();
      console.log(
        `  baseline run${run}: ${r.ms}ms exit ${r.exitCode}, remote reqs ${w.remote.requests} (ok ${w.remote.ok}, 404 ${w.remote.miss404})`
      );
    }

    // Cached: proxy in front, fresh worker per run; run1 fills the disk
    // cache, run2 reads it.
    for (const run of [1, 2]) {
      const w = new BenchWorker(PATCHED_DIR);
      await w.init();
      const r = await w.compile(files, 'main.tex', driver, `http://127.0.0.1:${port}`);
      out[`cached-run${run}`] = {
        ms: r.ms,
        exitCode: r.exitCode,
        remote: { ...w.remote },
        pdfBytes: r.pdf?.byteLength ?? 0,
        cacheStats: { ...cache.stats },
      };
      w.terminate();
      console.log(
        `  cached run${run}: ${r.ms}ms exit ${r.exitCode}, remote reqs ${w.remote.requests} (ok ${w.remote.ok}, 404 ${w.remote.miss404})`
      );
    }
  } finally {
    server.close();
  }
  return out;
}

// ====== Report ======

function fmtPct(baselineMs, patchedMs) {
  if (!baselineMs) return '—';
  return `${(((baselineMs - patchedMs) / baselineMs) * 100).toFixed(1)}%`;
}

function renderReport(passes, remote) {
  const lines = [];
  lines.push('# BusyTeX benchmark — rerun-skip patch + TeX Live remote disk cache');
  lines.push('');
  lines.push(`Date: ${new Date().toISOString()}  |  samples/config: ${SAMPLES} (median reported)  |  drift: ${passes?.driftPct ?? '—'}%`);
  lines.push('');
  if (passes) {
    lines.push('## Scenario 1 — warm compile (pass-schedule fix, fully offline)');
    lines.push('');
    lines.push('| config | baseline median | patched median | speedup | passes b→p | exit | pdf identical |');
    lines.push('|---|---:|---:|---:|---|---|---|');
    for (const e of passes.equivalence) {
      const b = passes.results[`${e.config} [baseline]`];
      const p = passes.results[`${e.config} [patched]`];
      lines.push(
        `| ${e.config} | ${b.medianMs}ms | ${p.medianMs}ms | ${fmtPct(b.medianMs, p.medianMs)} | ${e.baselinePasses}→${e.patchedPasses} | ${e.bothOk ? 'OK' : 'FAIL'} | ${e.pdfIdentical ? 'yes' : 'NO'} |`
      );
    }
    lines.push('');
  }
  if (remote) {
    const b2 = remote['baseline-run2'];
    const c2 = remote['cached-run2'];
    const c1 = remote['cached-run1'];
    lines.push('## Scenario 2 — CJK cold start (ctex via remote TeX Live, fresh worker per run)');
    lines.push('');
    lines.push('| run | wall ms | exit | remote reqs | 200s | 404s |');
    lines.push('|---|---:|---|---:|---:|---:|');
    for (const [k, v] of Object.entries(remote)) {
      lines.push(`| ${k} | ${v.ms} | ${v.exitCode} | ${v.remote.requests} | ${v.remote.ok} | ${v.remote.miss404} |`);
    }
    lines.push('');
    if (b2 && c2 && b2.ms && c2.ms) {
      lines.push(
        `**Second-launch comparison**: baseline ${b2.ms}ms vs cached ${c2.ms}ms → **${fmtPct(b2.ms, c2.ms)} faster** (${(b2.ms / c2.ms).toFixed(2)}×). Cold-cache proxy run: ${c1?.ms ?? '—'}ms.`
      );
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ====== Main ======

(async () => {
  fs.mkdirSync(BENCH_TMP, { recursive: true });
  console.log('Preparing baseline variant (hardlinks + upstream pipeline)...');
  prepareBaselineDir();

  let passes = null;
  let remote = null;
  if (!ONLY || ONLY === 'passes') {
    console.log(`\nScenario 1: warm compiles, ${SAMPLES} samples each...`);
    passes = await runPassesScenario();
  }
  if (!SKIP_REMOTE && (!ONLY || ONLY === 'remote')) {
    console.log('\nScenario 2: CJK remote cold start (network-bound, may take minutes)...');
    remote = await runRemoteScenario();
  }

  const report = renderReport(passes, remote);
  fs.writeFileSync(path.join(BENCH_TMP, 'bench-report.md'), report);
  fs.writeFileSync(
    path.join(BENCH_TMP, 'bench-report.json'),
    JSON.stringify({ passes, remote }, null, 2)
  );
  console.log('\n' + report);
  console.log(`\nReport saved: .bench-tmp/bench-report.{md,json}`);
})().catch((err) => {
  console.error(`\n✗ bench failed: ${err.stack || err}`);
  process.exit(1);
});
