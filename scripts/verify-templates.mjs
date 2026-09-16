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
import fs from 'node:fs';
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

function initEngine(worker) {
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
      preload_data_packages_js: ['scipen-wasm://busytex/texlive-basic.js'],
      data_packages_js: ['scipen-wasm://busytex/texlive-extra.js'],
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

/** Pull the first few `!`-prefixed TeX errors out of a compile log. */
function extractErrors(log) {
  return log
    .split('\n')
    .filter((line) => line.startsWith('!') || line.includes('Fatal error'))
    .slice(0, 5);
}

(async () => {
  const manifest = readManifest();
  console.log(`Verifying ${manifest.templates.length} templates offline (engine: ${engineName})\n`);

  const { worker, ready } = startWorker();
  await ready;
  await initEngine(worker);

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
      if (result.exitCode === 0 && result.pdfBytes > 0) {
        console.log(`  ✓ ${template.id}: ${(result.pdfBytes / 1024).toFixed(1)} KB PDF`);
      } else {
        console.log(`  ✗ ${template.id}: exit ${result.exitCode}, ${result.pdfBytes} bytes`);
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
  process.exit(0);
})().catch((err) => {
  console.error(`\n✗ verification crashed: ${err.stack || err}`);
  process.exit(1);
});
