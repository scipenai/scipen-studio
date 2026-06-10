/**
 * @file download-busytex-wasm.js - BusyTeX WASM asset downloader
 * @description Downloads the official `texlyre-busytex` v1.1.1 release
 *              tarball (~480 MB) and selectively extracts only the
 *              runtime-relevant files into `public/wasm/busytex/`.
 *
 *              The official release ships a single tarball, but the
 *              runtime only ever reads ~6 files. We stream the tarball
 *              through `tar -xz --files-from` so big metadata blobs
 *              (`.txt`, `.profile`, `*.providespackage.txt`, etc.) are
 *              never written to disk — only what `busytex_worker.js` and
 *              `busytex_pipeline.js` actually fetch/import at runtime.
 *
 *              We deliberately pull the official tarball (not the CI
 *              build repo's per-file assets) because the CI builds ship
 *              a simplified `texlive-extra.data` (~190 MB) that omits
 *              packages present in the official 324 MB extra. Same source
 *              the upstream README recommends.
 *
 * Usage:
 *   node scripts/download-busytex-wasm.js [--minimal] [--force]
 *     --minimal  Skip texlive-extra (~325 MB saving; needs remoteEndpoint
 *                fallback for non-basic packages at compile time)
 *     --force    Re-download even if files exist
 *
 * Destination: public/wasm/busytex/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Configuration ======

const RELEASE_VERSION = 'v1.1.1';
const TARBALL_URL = `https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-${RELEASE_VERSION}/busytex-assets.tar.gz`;
const DEST_DIR = path.resolve(__dirname, '..', 'public', 'wasm', 'busytex');
/**
 * Persistent cache directory for the downloaded tarball. Kept inside
 * the repo (under a leading-dot folder so it's easy to .gitignore) so
 * a one-off extraction failure doesn't force another 480 MB download.
 * Versioned filename means stale caches from older releases get a
 * different name and won't be silently reused.
 */
const CACHE_DIR = path.resolve(__dirname, '..', '.busytex-cache');
const TARBALL_CACHE_PATH = path.join(CACHE_DIR, `busytex-assets-${RELEASE_VERSION}.tar.gz`);

/**
 * Runtime-required files (referenced by `fetch`/`importScripts` in
 * `busytex_worker.js` and `busytex_pipeline.js`). Names inside the
 * tarball are prefixed with `busytex/` — they sit at the archive root.
 */
const CORE_FILES = [
  'busytex/busytex_worker.js',
  'busytex/busytex_pipeline.js',
  'busytex/busytex.js',
  'busytex/busytex.wasm',
];

const BASIC_FILES = ['busytex/texlive-basic.js', 'busytex/texlive-basic.data'];

const EXTRA_FILES = ['busytex/texlive-extra.js', 'busytex/texlive-extra.data'];

// ====== Argument Parsing ======

const args = process.argv.slice(2);
const minimal = args.includes('--minimal');
const force = args.includes('--force');

const wantedTarPaths = [
  ...CORE_FILES,
  ...BASIC_FILES,
  ...(minimal ? [] : EXTRA_FILES),
];

// ====== Main ======

(async () => {
  console.log('BusyTeX WASM downloader');
  console.log(`  Source : ${TARBALL_URL}`);
  console.log(`  Mode   : ${minimal ? 'minimal (core + basic, ~118 MB)' : 'full (core + basic + extra, ~445 MB)'}`);
  console.log(`  Dest   : ${DEST_DIR}\n`);

  if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Skip the download entirely if every wanted file already exists and
  // --force isn't set. Idempotent re-runs are the common case (prebuild
  // re-invokes this on every CI/local build).
  const targets = wantedTarPaths.map((p) => path.join(DEST_DIR, path.basename(p)));
  if (!force && targets.every((t) => fs.existsSync(t))) {
    console.log('✓ All required files already present, skipping download.');
    // Manifest reflects current `--minimal`↔full mode; refresh on every
    // run so a toggle is picked up even without re-downloading the tarball.
    writeManifest(DEST_DIR, minimal);
    return;
  }

  try {
    // Reuse a cached tarball if it looks complete. We can't verify a
    // checksum (the release doesn't publish one), so size is the only
    // proxy — a partial download would be smaller than the published
    // ~480 MB and warrants a retry.
    const MIN_TARBALL_SIZE = 400 * 1024 * 1024; // 400 MB safety floor below the 480 MB release
    const hasCachedTarball =
      !force &&
      fs.existsSync(TARBALL_CACHE_PATH) &&
      fs.statSync(TARBALL_CACHE_PATH).size > MIN_TARBALL_SIZE;

    if (hasCachedTarball) {
      console.log(`✓ Using cached tarball (${formatMB(fs.statSync(TARBALL_CACHE_PATH).size)})`);
    } else {
      await downloadTarball(TARBALL_URL, TARBALL_CACHE_PATH);
    }
    extractSelective(TARBALL_CACHE_PATH, DEST_DIR, wantedTarPaths);
    writeManifest(DEST_DIR, minimal);
    console.log(`\n✓ Done. Extracted ${wantedTarPaths.length} files into ${DEST_DIR}`);
    console.log(`  (tarball cached at ${TARBALL_CACHE_PATH} for future re-extracts)`);
  } catch (err) {
    throw err;
  }
})().catch((err) => {
  console.error(`\n✗ Failed: ${err.message}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    console.error(`  (proxy env: HTTPS_PROXY=${process.env.HTTPS_PROXY || '<unset>'})`);
  } else {
    console.error(`  Hint: GitHub releases can be slow without a proxy.`);
    console.error(`  Set HTTPS_PROXY=http://127.0.0.1:<port> and re-run.`);
  }
  process.exit(1);
});

// ====== Helpers ======

function downloadTarball(url, destPath) {
  // Node's built-in https module ignores HTTPS_PROXY env vars, so we
  // delegate to `curl` (bundled with Win10+, Mac, Linux) which honours
  // them natively. This also gives us free TLS, redirect handling,
  // and resumable download support — none of which we'd want to
  // reimplement in 100 lines of error-prone https.get glue.
  return new Promise((resolve, reject) => {
    console.log(`Downloading busytex-assets.tar.gz (proxy=${process.env.HTTPS_PROXY || '<none>'}) ...`);

    const args = [
      '--fail',          // exit non-zero on HTTP >=400
      '--location',      // follow redirects (GitHub releases redirects to cloud)
      '--silent',        // no progress bar in stdout
      '--show-error',    // but still print errors to stderr
      '--retry', '3',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      '--max-time', '1800', // 30 min ceiling — way past 480 MB at any reasonable speed
      '--progress-bar',  // a single line, written to stderr
      '-o', destPath,
      url,
    ];

    const proc = spawn('curl', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env, // inherits HTTPS_PROXY/HTTP_PROXY
    });

    proc.on('error', (err) => {
      reject(new Error(`curl spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        process.stdout.write(`\n  ✓ Downloaded ${formatMB(size)}\n`);
        resolve();
      } else {
        // Don't leave a partial behind for the size-based cache check
        // to mistake as complete.
        try { fs.unlinkSync(destPath); } catch {}
        reject(new Error(`curl exited with code ${code}`));
      }
    });
  });
}

/**
 * Use the system `tar` (bundled with Win10+, Mac, Linux) to extract
 * only the files we care about. `-x --files-from` skips everything
 * else without ever materializing it on disk, which keeps the temp
 * footprint at exactly one .tar.gz instead of doubling on extraction.
 * Files are extracted with their tar-archive paths preserved, then
 * we strip the `busytex/` prefix by extracting into DEST_DIR with
 * `--strip-components 1`.
 *
 * Windows tar tooling caveat:
 *   - System32 tar.exe (BSD libarchive) wants native `C:\...` paths
 *     and rejects forward-slash drive paths like `C:/...`.
 *   - GNU tar from Git Bash treats `C:` as a hostname.
 *   We use System32 tar.exe and feed it native backslash paths;
 *   on non-Windows platforms the path style doesn't matter.
 */
function extractSelective(tarballPath, destDir, wantedTarPaths) {
  console.log(`Extracting ${wantedTarPaths.length} files ...`);

  const tarBinary = resolveTarBinary();
  const isWin = process.platform === 'win32';
  // BSD tar (System32 tar.exe) requires `\` on Windows;
  // libarchive on Unix-like platforms accepts both.
  const tarballArg = isWin ? tarballPath.replace(/\//g, '\\') : tarballPath;
  const destArg = isWin ? destDir.replace(/\//g, '\\') : destDir;

  const result = spawnSync(
    tarBinary,
    ['-xzf', tarballArg, '-C', destArg, '--strip-components=1', ...wantedTarPaths],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (result.status !== 0) {
    throw new Error(`tar exited with code ${result.status}`);
  }
  for (const p of wantedTarPaths) {
    const dest = path.join(destDir, path.basename(p));
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    console.log(`  ✓ ${path.basename(p)} (${formatMB(size)})`);
  }
}

/**
 * Pick a tar binary that understands native Windows paths. The Win10+
 * System32 `tar.exe` is libarchive-based (BSD-style) and handles
 * `C:\...` directly. Git Bash's `/usr/bin/tar` (GNU tar from MSYS)
 * mistakes drive letters for hostnames — avoid it.
 */
function resolveTarBinary() {
  if (process.platform !== 'win32') return 'tar';
  const system32Tar = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'tar.exe'
  );
  return fs.existsSync(system32Tar) ? system32Tar : 'tar';
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Write a manifest.json describing which TeX Live data packages are
 * actually available on disk. The renderer reads this at engine init
 * instead of hardcoding package names — keeps the two sides in sync.
 *
 * Why JSON (not a JS module)? The renderer fetches it via the
 * `scipen-wasm://` protocol the same way it loads the rest of the
 * busytex assets — no extra plumbing, no module-graph entanglement.
 *
 * Why not just `fs.readdir` at runtime in renderer? Renderer can't
 * walk the filesystem; main-process IPC would work but adds an async
 * channel for what is effectively static build-time data. A manifest
 * file is the simpler invariant: the script that puts the .js packages
 * on disk also writes the list of names — single source of truth.
 *
 * Field semantics mirror BusyTeX's worker init message:
 *   - preload: data packages eagerly loaded into the WASM FS at init
 *   - catalog: data packages importScripts()'d on demand by the pipeline
 */
function writeManifest(destDir, minimal) {
  const manifest = {
    version: RELEASE_VERSION,
    mode: minimal ? 'minimal' : 'full',
    preload: ['texlive-basic.js'],
    catalog: minimal ? [] : ['texlive-extra.js'],
  };
  const manifestPath = path.join(destDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  ✓ manifest.json (${manifest.mode}: preload=${manifest.preload.length}, catalog=${manifest.catalog.length})`);
}
