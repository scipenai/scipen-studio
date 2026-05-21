/**
 * @file build-snaca.js — Build & stage the snaca-editor binary.
 * @description
 *   1. Runs `cargo build --release -p snaca-editor` against the in-tree
 *      snaca workspace (`snaca/`).
 *   2. Copies the resulting executable into `resources/bin/` so that the
 *      `electron-builder.json5` `extraResources` rule picks it up.
 *   3. With `--install`, also copies into the installed application's
 *      runtime resources directory so a running packaged build picks up
 *      the fresh binary on next launch — saves rebuilding the installer
 *      during Rust-only iteration.
 *
 *   The script is idempotent: if the staged copy is newer than the cargo
 *   output and `--force` is not passed, the cargo step is skipped.
 *
 * Usage:
 *   node scripts/build-snaca.js              # incremental, stage only
 *   node scripts/build-snaca.js --force      # always re-run cargo
 *   node scripts/build-snaca.js --install    # also deploy to installed app
 *   SCIPEN_SKIP_SNACA_BUILD=1 …              # skip entirely (dev who handles it themselves)
 *   SCIPEN_SNACA_INSTALL_DIR=<path>          # override the auto-detected install dir
 *
 * @depends node:child_process, node:fs, node:path
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const snacaDir = resolve(rootDir, 'snaca');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exe = isWin ? '.exe' : '';
const binaryName = `snaca-editor${exe}`;
const cargoOutput = resolve(snacaDir, 'target', 'release', binaryName);
const stagedBinDir = resolve(rootDir, 'resources', 'bin');
const stagedBinary = resolve(stagedBinDir, binaryName);

function log(msg) {
  process.stdout.write(`[build-snaca] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[build-snaca] ${msg}\n`);
}

if (process.env.SCIPEN_SKIP_SNACA_BUILD === '1') {
  log('SCIPEN_SKIP_SNACA_BUILD=1 set; skipping');
  process.exit(0);
}

if (!existsSync(snacaDir)) {
  err(`snaca workspace not found at ${snacaDir}; skipping build`);
  process.exit(0);
}

const force = process.argv.includes('--force');
const skipCargo =
  !force &&
  existsSync(cargoOutput) &&
  existsSync(stagedBinary) &&
  statSync(stagedBinary).mtimeMs >= statSync(cargoOutput).mtimeMs;

if (skipCargo) {
  log(`staged binary up-to-date; skipping cargo build (use --force to override)`);
} else {
  log(`running cargo build --release -p snaca-editor`);
  const result = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'snaca-editor'],
    {
      cwd: snacaDir,
      stdio: 'inherit',
      shell: isWin, // resolve cargo via PATH on Windows
    }
  );
  if (result.status !== 0) {
    err(`cargo build failed (exit ${result.status ?? 'null'})`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(cargoOutput)) {
  err(`cargo output not found: ${cargoOutput}`);
  process.exit(1);
}

if (!existsSync(stagedBinDir)) {
  mkdirSync(stagedBinDir, { recursive: true });
}
copyFileSync(cargoOutput, stagedBinary);
log(`staged → ${stagedBinary}`);

// ----- Optional: deploy into the installed app's resources/bin -----
if (process.argv.includes('--install')) {
  const installDir = resolveInstallBinDir();
  if (!installDir) {
    err(
      'cannot locate installed SciPen Studio. ' +
        'Set SCIPEN_SNACA_INSTALL_DIR=<path-to-installed-resources/bin> and retry.'
    );
    process.exit(2);
  }
  const installedBinary = join(installDir, binaryName);
  if (!existsSync(installDir)) {
    err(`install dir does not exist: ${installDir}`);
    process.exit(2);
  }
  try {
    // Windows holds an exclusive lock on a running .exe. Surface a
    // clear "close the app first" error rather than a cryptic EBUSY.
    copyFileSync(stagedBinary, installedBinary);
    log(`deployed → ${installedBinary}`);
  } catch (e) {
    err(
      `failed to deploy: ${e?.message ?? e}. ` +
        `If SciPen Studio is running, quit it first and retry.`
    );
    process.exit(2);
  }
}

/**
 * Locate the installed application's `resources/bin/` directory. Manual
 * override takes precedence; otherwise probe the per-platform default
 * (Windows user-local install / macOS bundle / Linux /opt). Returns
 * `null` when nothing is found — caller surfaces the override hint.
 */
function resolveInstallBinDir() {
  if (process.env.SCIPEN_SNACA_INSTALL_DIR) {
    return process.env.SCIPEN_SNACA_INSTALL_DIR;
  }
  if (isWin) {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    const candidate = join(local, 'Programs', 'SciPen Studio', 'resources', 'bin');
    return existsSync(candidate) ? candidate : null;
  }
  if (isMac) {
    const candidate = '/Applications/SciPen Studio.app/Contents/Resources/bin';
    return existsSync(candidate) ? candidate : null;
  }
  // Linux — electron-builder AppImage doesn't have a stable install
  // root; we assume Snap/.deb landed at /opt. Users who installed via
  // AppImage need to set SCIPEN_SNACA_INSTALL_DIR explicitly.
  const candidate = '/opt/SciPen Studio/resources/bin';
  return existsSync(candidate) ? candidate : null;
}
