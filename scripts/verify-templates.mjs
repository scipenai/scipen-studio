/**
 * @file verify-templates.mjs — compile every bundled template offline.
 *
 * Acceptance gate for `resources/templates/`: a template that cannot build
 * with the shipped BusyTeX assets and NO remote endpoint would strand a user
 * who clicked "New from template" on a plane — the exact scenario the local
 * compiler exists for.
 *
 * Reuses the benchmark worker shim (scripts/bench/worker-shim.mjs), which
 * runs the browser-targeted BusyTeX worker under node.
 *
 * Usage: node scripts/verify-templates.mjs [--engine pdftex|xetex|lualatex]
 * Exit code is non-zero if any template fails, so CI can gate on it.
 */

import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES_DIR = path.join(ROOT, 'resources', 'templates');
const WASM_DIR = path.join(ROOT, 'public', 'wasm', 'busytex');
const SHIM = path.join(ROOT, 'scripts', 'bench', 'worker-shim.mjs');

const DRIVERS = {
  pdftex: 'pdftex_bibtex8',
  xetex: 'xetex_bibtex8_dvipdfmx',
  lualatex: 'luahbtex_bibtex8',
};

const args = process.argv.slice(2);
const engineIdx = args.indexOf('--engine');
const engineName = engineIdx >= 0 ? args[engineIdx + 1] : 'pdftex';
const driver = DRIVERS[engineName];
if (!driver) {
  console.error(`Unknown engine "${engineName}". Use one of: ${Object.keys(DRIVERS).join(', ')}`);
  process.exit(1);
}

function readManifest() {
  const manifestPath = path.join(TEMPLATES_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest at ${manifestPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function readWasmManifest() {
  const manifestPath = path.join(WASM_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`No WASM manifest at ${manifestPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** Read every file in a template dir into BusyTeX's `{path, contents}` shape. */
function collectFiles(dir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else files.push({ path: rel, contents: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(dir, '');
  return files;
}

function startWorker() {
  const worker = new Worker(SHIM, { workerData: { variantDir: WASM_DIR } });
  const ready = new Promise((resolve) => {
    const onMessage = (m) => {
      if (m.benchReady) {
        worker.off('message', onMessage);
        resolve();
      }
    };
    worker.on('message', onMessage);
  });
  return { worker, ready };
}

function initEngine(worker, wasmManifest) {
  const preloadPackages = (wasmManifest.preload ?? ['texlive-basic.js']).map(
    (name) => `scipen-wasm://busytex/${name}`
  );
  // Mirror production baseCatalogList: exclude optional texlive-cjk.js so
  // English templates remain isolated from CJK data package loading.
  const catalogPackages = (wasmManifest.catalog ?? [])
    .filter((name) => name !== 'texlive-cjk.js')
    .map((name) => `scipen-wasm://busytex/${name}`);

  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.exception) {
        worker.off('message', onMessage);
        reject(new Error(m.exception));
      } else if (m.initialized) {
        worker.off('message', onMessage);
        resolve();
      }
    };
    worker.on('message', onMessage);
    worker.postMessage({
      busytex_js: 'scipen-wasm://busytex/busytex.js',
      busytex_wasm: 'scipen-wasm://busytex/busytex.wasm',
      preload_data_packages_js: preloadPackages,
      data_packages_js: catalogPackages,
      texmf_local: [],
      preload: true,
    });
  });
}

function compile(worker, files, mainFile) {
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.exception) {
        worker.off('message', onMessage);
        reject(new Error(m.exception));
        return;
      }
      if (m.exit_code !== undefined || m.pdf !== undefined) {
        worker.off('message', onMessage);
        resolve({
          exitCode: m.exit_code ?? -1,
          pdfBytes: m.pdf ? m.pdf.byteLength ?? m.pdf.length ?? 0 : 0,
          log: m.log ?? '',
          logs: Array.isArray(m.logs) ? m.logs : [],
        });
      }
    };
    worker.on('message', onMessage);
    worker.postMessage({
      files,
      main_tex_path: mainFile,
      bibtex: null,
      makeindex: null,
      rerun: null,
      verbose: 'silent',
      driver,
      data_packages_js: null,
      // No endpoint: this is the offline guarantee under test.
      remote_endpoint: '',
    });
  });
}

/** Validate strict sub-command exit status, BibTeX execution, and citations. */
function validateCompileResult(result, files) {
  const issues = [];
  if (result.exitCode !== 0 || result.pdfBytes <= 0) {
    issues.push(`exit ${result.exitCode}, ${result.pdfBytes} bytes`);
  }
  if (!Array.isArray(result.logs) || result.logs.length === 0) {
    issues.push('missing structured command logs');
  } else {
    for (const entry of result.logs) {
      if (!Number.isInteger(entry?.raw_exit_code) || entry.raw_exit_code !== 0) {
        issues.push(
          `command "${entry?.cmd || 'unknown'}" returned raw_exit_code=${entry?.raw_exit_code}`
        );
      }
    }
    const usesBibliography = files.some(
      (f) => f.path.endsWith('.tex') && /\\bibliography\s*\{/.test(f.contents)
    );
    if (
      usesBibliography &&
      !result.logs.some((entry) => typeof entry.cmd === 'string' && entry.cmd.startsWith('bibtex8'))
    ) {
      issues.push('expected bibtex8 command entry for template containing \\bibliography{');
    }
    const finalTexEntry = [...result.logs]
      .reverse()
      .find(
        (entry) =>
          typeof entry?.cmd === 'string' &&
          /^(?:pdflatex|xelatex|lualatex|luahblatex)\b/.test(entry.cmd)
      );
    if (!finalTexEntry) {
      issues.push('missing final TeX command log entry');
    } else if (
      /There were undefined citations|Citation .* undefined/i.test(finalTexEntry.log || '')
    ) {
      issues.push('undefined citations detected in final TeX log');
    }
  }
  return issues;
}

/** Run headless Electron UtilityProcess CJK & isolation verification when XeTeX runs in full mode. */
function runElectronVerification(wasmManifest) {
  const catalog = wasmManifest.catalog ?? [];
  const cjkJs = path.join(WASM_DIR, 'texlive-cjk.js');
  const cjkData = path.join(WASM_DIR, 'texlive-cjk.data');
  const workerEntry = path.join(ROOT, 'out', 'main', 'busytex-process', 'index.cjs');

  if (!catalog.includes('texlive-cjk.js')) {
    throw new Error('Full WASM manifest must include texlive-cjk.js in catalog');
  }
  if (!fs.existsSync(cjkJs) || fs.statSync(cjkJs).size <= 0) {
    throw new Error(`Missing or empty ${cjkJs}`);
  }
  if (!fs.existsSync(cjkData) || fs.statSync(cjkData).size <= 0) {
    throw new Error(`Missing or empty ${cjkData}`);
  }
  if (!fs.existsSync(workerEntry)) {
    throw new Error(`Missing ${workerEntry} — run npm run build:workers first`);
  }

  const require = createRequire(import.meta.url);
  const electronBin = require('electron');
  const electronScript = path.join(ROOT, 'scripts', 'verify-busytex-electron.cjs');

  let cmd = electronBin;
  let args = [electronScript];
  if (process.platform === 'linux') {
    const electronArgs = ['--no-sandbox', electronScript];
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      cmd = 'xvfb-run';
      args = ['-a', electronBin, ...electronArgs];
    } else {
      args = electronArgs;
    }
  }

  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`verify-busytex-electron exited with code ${res.status}`);
  }
}

/** Pull the first few `!`-prefixed TeX errors out of a compile log. */
function extractErrors(log) {
  return log
    .split('\n')
    .filter((line) => line.startsWith('!') || line.includes('Fatal error'))
    .slice(0, 5);
}

(async () => {
  const manifest = readManifest();
  const wasmManifest = readWasmManifest();
  console.log(`Verifying ${manifest.templates.length} templates offline (engine: ${engineName})\n`);

  const { worker, ready } = startWorker();
  await ready;
  await initEngine(worker, wasmManifest);

  const failures = [];
  for (const template of manifest.templates) {
    const dir = path.join(TEMPLATES_DIR, template.dir);
    if (!fs.existsSync(path.join(dir, template.mainFile))) {
      console.log(`  ✗ ${template.id}: mainFile "${template.mainFile}" missing`);
      failures.push(template.id);
      continue;
    }
    const files = collectFiles(dir);
    try {
      const result = await compile(worker, files, template.mainFile);
      const issues = validateCompileResult(result, files);
      if (issues.length === 0) {
        console.log(`  ✓ ${template.id}: ${(result.pdfBytes / 1024).toFixed(1)} KB PDF`);
      } else {
        console.log(`  ✗ ${template.id}: ${issues.join('; ')}`);
        for (const err of extractErrors(result.log)) console.log(`      ${err}`);
        failures.push(template.id);
      }
    } catch (err) {
      console.log(`  ✗ ${template.id}: ${err.message.split('\n')[0]}`);
      failures.push(template.id);
    }
  }

  worker.terminate();

  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} template(s) failed offline: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ All templates compile offline with the bundled engine.');

  if (engineName === 'xetex' && wasmManifest.mode !== 'minimal') {
    console.log('');
    runElectronVerification(wasmManifest);
  }
  process.exit(0);
})().catch((err) => {
  console.error(`\n✗ verification crashed: ${err.stack || err}`);
  process.exit(1);
});
