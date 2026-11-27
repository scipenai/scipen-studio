/**
 * @file verify-busytex-electron.cjs — End-to-end verification of the compiled
 * BusyTeX UtilityProcess bundle (`out/main/busytex-process/index.cjs`) inside
 * real Electron `app.whenReady()` + `utilityProcess.fork()`.
 *
 * Exercises production CJK auto-mounting, empty-endpoint offline compiles,
 * zero-curl default-endpoint compiles, non-CJK resolver isolation, and
 * same-process mirror switching (`KPSE_REMOTE` + `/tmp/texlive_remote` reset).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, utilityProcess } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'out', 'main', 'busytex-process', 'index.cjs');
const WASM_ASSETS_DIR = path.join(ROOT, 'public', 'wasm', 'busytex');
const ARTICLE_TEMPLATE_DIR = path.join(ROOT, 'resources', 'templates', 'article');

const READY_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 120_000;

const XETEX_DRIVER = 'xetex_bibtex8_dvipdfmx';
const PDFTEX_DRIVER = 'pdftex_bibtex8';
const DEFAULT_ENDPOINT = 'https://texlive2026.texlyre.org';

function normaliseRoot(root) {
  const resolved = path.resolve(root).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dst = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

async function runInFreshUtilityProcess(name, fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `scipen-verify-${name}-`));
  const remoteCacheDir = path.join(tmpBase, 'remote-cache');
  const buildCacheDir = path.join(tmpBase, 'build-cache');
  const projectDir = path.join(tmpBase, 'project');
  const outputDir = path.join(tmpBase, 'output');
  fs.mkdirSync(remoteCacheDir, { recursive: true });
  fs.mkdirSync(buildCacheDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const proc = utilityProcess.fork(ENTRY, [], {
    serviceName: `scipen-verify-${name}`,
    execArgv: [],
    stdio: 'pipe',
    env: {
      ...process.env,
      WASM_ASSETS_DIR,
      TEXLIVE_CACHE_DIR: remoteCacheDir,
      BUSYTEX_BUILD_CACHE_DIR: buildCacheDir,
      NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
      no_proxy: [process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    },
  });

  let stderrTail = '';
  const appendLog = (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
  };
  proc.stdout?.on('data', appendLog);
  proc.stderr?.on('data', appendLog);

  let exited = false;
  let exitResolve;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  const pending = new Map();
  const statsEvents = [];
  let seq = 0;

  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    readyReject(new Error(`[${name}] timed out waiting for utilityProcess ready`));
  }, READY_TIMEOUT_MS);

  const rejectAll = (err) => {
    clearTimeout(readyTimer);
    readyReject(err);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      pending.delete(id);
    }
  };

  proc.on('exit', (code) => {
    exited = true;
    exitResolve(code);
    rejectAll(
      new Error(`[${name}] utilityProcess exited early with code ${code}\n${stderrTail.trim()}`)
    );
  });

  proc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'event') {
      if (msg.event === 'ready') {
        clearTimeout(readyTimer);
        readyResolve();
      } else if (msg.event === 'stats' && msg.data && typeof msg.data === 'object') {
        statsEvents.push(msg.data);
      }
      return;
    }
    if (msg.type === 'response') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }
  });

  const call = (method, params, timeoutMs) => {
    if (exited) {
      return Promise.reject(new Error(`[${name}] utilityProcess already exited`));
    }
    const id = `req-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`[${name}] RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.postMessage({ id, type: 'request', method, params });
    });
  };

  const compileDoc = async ({ mainRelPath = 'main.tex', content, driver, endpoint }) => {
    const mainFileAbs = path.join(projectDir, mainRelPath);
    fs.mkdirSync(path.dirname(mainFileAbs), { recursive: true });
    fs.writeFileSync(mainFileAbs, content, 'utf8');
    const beforeLen = statsEvents.length;
    const result = await call(
      'compile',
      {
        projectRoot: projectDir,
        mainFileAbs,
        overlay: { absPath: mainFileAbs, contents: content },
        outputDir,
        baseName: path.basename(mainRelPath, path.extname(mainRelPath)),
        driver,
        endpoint,
      },
      COMPILE_TIMEOUT_MS
    );
    const compileStats = statsEvents.slice(beforeLen).find((s) => s.phase === 'compile') || {};
    return { result, stats: compileStats };
  };

  try {
    await readyPromise;
    return await fn({
      call,
      compileDoc,
      remoteCacheDir,
      buildCacheDir,
      projectDir,
      outputDir,
    });
  } finally {
    clearTimeout(readyTimer);
    if (!exited) {
      proc.kill();
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort temp cleanup */
    }
  }
}

async function runAllFixtures() {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`Missing production worker entry: ${ENTRY}`);
  }
  const cjkJs = path.join(WASM_ASSETS_DIR, 'texlive-cjk.js');
  const cjkData = path.join(WASM_ASSETS_DIR, 'texlive-cjk.data');
  if (!fs.existsSync(cjkJs) || !fs.existsSync(cjkData)) {
    throw new Error(`Missing texlive-cjk assets in ${WASM_ASSETS_DIR}`);
  }

  const fixtures = [
    [
      'ctex-article-offline',
      async ({ call, compileDoc, projectDir }) => {
        await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);
        const { result, stats } = await compileDoc({
          driver: XETEX_DRIVER,
          endpoint: '',
          content: [
            '\\documentclass{article}',
            '\\usepackage[fontset=fandol]{ctex}',
            '\\begin{document}',
            '\\section{离线中文测试}',
            '使用 bundled ctex 与 Fandol 字库进行零联网编译验证。',
            '\\end{document}',
            '',
          ].join('\n'),
        });
        assert.equal(result.exitCode, 0, `log:\n${result.log}`);
        assert.ok(stats.pdfBytes > 0, 'expected non-empty PDF');
        assert.equal(stats.fetched200, 0, 'expected zero HTTP 200 remote fetches');
        assert.equal(stats.fetched404, 0, 'expected zero HTTP 404 remote probes');
      },
    ],
    [
      'ctexart-bare-offline',
      async ({ call, compileDoc, projectDir }) => {
        await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);
        const cold = await compileDoc({
          driver: XETEX_DRIVER,
          endpoint: '',
          content: [
            '\\documentclass{ctexart}',
            '\\begin{document}',
            '\\section{无显式导言冷编译}',
            '第一轮冷编译正文。',
            '\\end{document}',
            '',
          ].join('\n'),
        });
        assert.equal(cold.result.exitCode, 0, `cold log:\n${cold.result.log}`);
        assert.ok(cold.stats.pdfBytes > 0, 'expected non-empty cold PDF');
        assert.equal(cold.stats.fetched200, 0, 'expected zero HTTP 200 remote fetches');
        assert.equal(cold.stats.fetched404, 0, 'expected zero HTTP 404 remote probes');

        const warm = await compileDoc({
          driver: XETEX_DRIVER,
          endpoint: '',
          content: [
            '\\documentclass{ctexart}',
            '\\begin{document}',
            '\\section{无显式导言冷编译}',
            '第二轮增量编译正文更新。',
            '\\end{document}',
            '',
          ].join('\n'),
        });
        assert.equal(warm.result.exitCode, 0, `warm log:\n${warm.result.log}`);
        assert.equal(warm.stats.texPasses, 1, `expected 1 pass on incremental run, got ${warm.stats.texPasses}`);
        assert.ok(
          warm.stats.artifactsInjected > 0,
          `expected injected artifacts > 0, got ${warm.stats.artifactsInjected}`
        );
      },
    ],
    [
      'ctexart-windows-fontset-offline',
      async ({ call, compileDoc, projectDir }) => {
        await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);
        const { result, stats } = await compileDoc({
          driver: XETEX_DRIVER,
          endpoint: '',
          content: [
            '\\documentclass[fontset=windows]{ctexart}',
            '\\begin{document}',
            '\\section{Windows 字库映射离线测试}',
            '验证 ctex-fontset-windows 与别名中文字体可离线完成排版。',
            '\\end{document}',
            '',
          ].join('\n'),
        });
        assert.equal(result.exitCode, 0, `log:\n${result.log}`);
        assert.ok(stats.pdfBytes > 0, 'expected non-empty PDF for fontset=windows');
      },
    ],
    [
      'ctex-default-endpoint-zero-curl',
      async ({ call, compileDoc, projectDir, remoteCacheDir }) => {
        assert.equal(fs.readdirSync(remoteCacheDir).length, 0, 'remote cache must start empty');
        await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);
        const { result, stats } = await compileDoc({
          driver: XETEX_DRIVER,
          endpoint: DEFAULT_ENDPOINT,
          content: [
            '\\documentclass{article}',
            '\\usepackage[fontset=fandol]{ctex}',
            '\\usepackage{amsmath,hyperref}',
            '\\begin{document}',
            '\\tableofcontents',
            '\\section{默认端点零网络请求测试}',
            '公式 $E = mc^2$ 与目录测试。',
            '\\end{document}',
            '',
          ].join('\n'),
        });
        assert.equal(result.exitCode, 0, `log:\n${result.log}`);
        assert.ok(stats.pdfBytes > 0, 'expected non-empty PDF');
        assert.equal(stats.fetched200, 0, `expected fetched200 === 0, got ${stats.fetched200}`);
        assert.equal(stats.fetched404, 0, `expected fetched404 === 0, got ${stats.fetched404}`);
        assert.equal(stats.curlMs, 0, `expected curlMs === 0, got ${stats.curlMs}`);
      },
    ],
    [
      'english-article-no-cjk-mount',
      async ({ call, compileDoc, projectDir, buildCacheDir }) => {
        copyDirRecursive(ARTICLE_TEMPLATE_DIR, projectDir);
        const mainPath = path.join(projectDir, 'main.tex');
        const mainTex = fs.readFileSync(mainPath, 'utf8');
        await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);
        const { result, stats } = await compileDoc({
          driver: PDFTEX_DRIVER,
          endpoint: '',
          content: mainTex,
        });
        assert.equal(result.exitCode, 0, `article log:\n${result.log}`);
        assert.ok(stats.pdfBytes > 0, 'expected non-empty article PDF');

        const warmPath = path.join(buildCacheDir, 'warm-packages.json');
        assert.ok(fs.existsSync(warmPath), 'warm-packages.json should exist after clean compile');
        const warmMap = JSON.parse(fs.readFileSync(warmPath, 'utf8'));
        const entry = warmMap[normaliseRoot(projectDir)];
        assert.ok(Array.isArray(entry), 'expected warm-packages entry for article project');
        assert.ok(
          !entry.some((pkg) => String(pkg).includes('texlive-cjk.js')),
          `unexpected texlive-cjk.js mounted for English article: ${JSON.stringify(entry)}`
        );
      },
    ],
    [
      'endpoint-switch-no-stale-miss',
      async ({ call, compileDoc, projectDir }) => {
        const requestCounts = new Map();
        const server = http.createServer((req, res) => {
          const reqPath = (req.url || '/').split('?')[0];
          requestCounts.set(reqPath, (requestCounts.get(reqPath) || 0) + 1);
          if (reqPath === '/26/hyperref.cfg') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('% custom mirror cfg\n\\typeout{SCIPEN_CUSTOM_MIRROR_CFG}\n');
            return;
          }
          res.writeHead(404);
          res.end();
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const addr = server.address();
        const mirrorUrl = `http://127.0.0.1:${addr.port}`;

        try {
          await call('load', { projectRoot: projectDir }, LOAD_TIMEOUT_MS);

          const first = await compileDoc({
            driver: PDFTEX_DRIVER,
            endpoint: DEFAULT_ENDPOINT,
            content: [
              '\\documentclass{article}',
              '\\usepackage{hyperref}',
              '\\begin{document}',
              'First pass against pinned default snapshot.',
              '\\end{document}',
              '',
            ].join('\n'),
          });
          assert.equal(first.result.exitCode, 0, `first log:\n${first.result.log}`);
          assert.equal(first.stats.curlMs, 0, `expected first pass curlMs === 0, got ${first.stats.curlMs}`);

          const second = await compileDoc({
            driver: PDFTEX_DRIVER,
            endpoint: mirrorUrl,
            content: [
              '\\documentclass{article}',
              '\\usepackage{hyperref}',
              '\\begin{document}',
              'Second pass after switching to custom mirror.',
              '\\end{document}',
              '',
            ].join('\n'),
          });
          assert.equal(second.result.exitCode, 0, `second log:\n${second.result.log}`);
          const hits = requestCounts.get('/26/hyperref.cfg') || 0;
          assert.ok(
            hits >= 1,
            `expected mock mirror to receive >= 1 request for /26/hyperref.cfg after endpoint switch, got ${hits}`
          );
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      },
    ],
  ];

  const failures = [];
  console.log('Verifying production Electron BusyTeX UtilityProcess CJK & isolation contracts\n');
  for (const [name, fn] of fixtures) {
    const t0 = Date.now();
    try {
      await runInFreshUtilityProcess(name, fn);
      console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    } catch (err) {
      failures.push(name);
      console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ Electron BusyTeX verification failed: ${failures.join(', ')}`);
    return 1;
  }
  console.log('\n✓ All Electron UtilityProcess BusyTeX checks passed.');
  return 0;
}

app
  .whenReady()
  .then(runAllFixtures)
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error(`✗ verify-busytex-electron crashed: ${err?.stack || err}`);
    app.exit(1);
  });
