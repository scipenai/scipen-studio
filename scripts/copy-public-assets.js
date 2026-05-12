/**
 * @file copy-public-assets.js - Renderer asset copier
 * @description Copies runtime assets shipped via npm packages into the renderer's
 *              `public/` directory. Idempotent — safe to run on every build.
 *              Sources are pinned to `package.json` deps; the copy targets are
 *              gitignored so we always ship exactly what npm resolves.
 * @depends fs, path, url
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');

// Each entry: copy `from` -> `to`, with optional `files` filter.
// `files` is null = copy everything; array = copy only matching basenames.
const COPY_TARGETS = [
  {
    name: 'pdf.js CMaps (CJK rendering)',
    from: 'node_modules/pdfjs-dist/cmaps',
    to: 'public/cmaps',
    files: null,
  },
];

function copyDirSelective(srcDir, destDir, filter) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory missing: ${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (filter && !filter.includes(entry.name)) continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    copied += 1;
  }
  return copied;
}

let exitCode = 0;
for (const target of COPY_TARGETS) {
  const srcAbs = path.join(repoRoot, target.from);
  const destAbs = path.join(repoRoot, target.to);
  try {
    const count = copyDirSelective(srcAbs, destAbs, target.files);
    console.log(`✓ ${target.name}: copied ${count} files -> ${target.to}`);
  } catch (err) {
    console.error(`✗ ${target.name}: ${err.message}`);
    exitCode = 1;
  }
}
process.exit(exitCode);
