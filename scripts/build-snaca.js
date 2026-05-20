/**
 * @file build-snaca.js — Build & stage the snaca-editor binary.
 * @description
 *   1. Runs `cargo build --release -p snaca-editor` against the in-tree
 *      snaca workspace (`snaca/`).
 *   2. Copies the resulting executable into `resources/bin/` so that the
 *      `electron-builder.json5` `extraResources` rule picks it up.
 *
 *   The script is idempotent: if the staged copy is newer than the cargo
 *   output and `--force` is not passed, the cargo step is skipped.
 *
 * Usage:
 *   node scripts/build-snaca.js          # incremental
 *   node scripts/build-snaca.js --force  # always re-run cargo
 *   SCIPEN_SKIP_SNACA_BUILD=1 …          # skip entirely (dev who handles it themselves)
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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const snacaDir = resolve(rootDir, 'snaca');
const isWin = process.platform === 'win32';
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
  // `--features fastembed` enables the ONNX embedder backend. The
  // model weights themselves are NOT bundled — they download lazily on
  // first use into `SCIPEN_FASTEMBED_CACHE_DIR`. Without the feature,
  // selecting "fastembed" in Studio Settings silently falls back to
  // HashEmbedder. Set `SCIPEN_SNACA_FEATURES=""` to opt out (CI builds
  // that don't ship to end users).
  const featuresArg =
    process.env.SCIPEN_SNACA_FEATURES !== undefined
      ? process.env.SCIPEN_SNACA_FEATURES
      : 'fastembed';
  const cargoArgs = ['build', '--release', '-p', 'snaca-editor'];
  if (featuresArg.trim()) {
    cargoArgs.push('--features', featuresArg);
  }
  log(`running cargo ${cargoArgs.join(' ')}`);
  const result = spawnSync('cargo', cargoArgs, {
    cwd: snacaDir,
    stdio: 'inherit',
    shell: isWin, // resolve cargo via PATH on Windows
  });
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
