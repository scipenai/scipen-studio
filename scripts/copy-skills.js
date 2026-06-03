/**
 * @file copy-skills.js — Stage academic-research-skills into resources/skills.
 * @description
 *   Copies the bundled skill directories from the sibling academic-research-skills
 *   repo into `resources/skills/<name>/` so electron-builder's `extraResources`
 *   rule ships them. SNACA loads them as the read-only Bundled scope at runtime
 *   (lowest priority — a user's tenant/project skill of the same name overrides).
 *
 *   Source overridable via `ARS_SKILLS_DIR`; a missing source is a HARD error so
 *   we never silently ship an empty skills dir.
 *
 * Usage:
 *   node scripts/copy-skills.js
 *   ARS_SKILLS_DIR=<path>     # override source repo location
 *   SCIPEN_SKIP_SKILLS=1      # skip (dev who doesn't need bundled skills)
 *
 * @depends node:fs, node:path, node:url
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const SKILLS = ['academic-paper', 'academic-paper-reviewer', 'academic-pipeline', 'deep-research'];
// Ship the skill body + references + scripts; drop dev/test/scaffolding weight.
const EXCLUDE = new Set([
  '.git',
  'node_modules',
  'tests',
  'test',
  'examples',
  '__pycache__',
  '.pytest_cache',
]);
const LICENSE_FILES = ['LICENSE', 'NOTICE.md', 'NOTICE'];

function log(msg) {
  process.stdout.write(`[copy-skills] ${msg}\n`);
}
function err(msg) {
  process.stderr.write(`[copy-skills] ${msg}\n`);
}

if (process.env.SCIPEN_SKIP_SKILLS === '1') {
  log('SCIPEN_SKIP_SKILLS=1 set; skipping');
  process.exit(0);
}

const srcRoot = process.env.ARS_SKILLS_DIR
  ? resolve(process.env.ARS_SKILLS_DIR)
  : resolve(rootDir, '..', 'academic-research-skills');

if (!existsSync(srcRoot)) {
  err(`academic-research-skills not found at ${srcRoot}.`);
  err('Clone it beside scipen-studio, set ARS_SKILLS_DIR=<path>, or SCIPEN_SKIP_SKILLS=1.');
  process.exit(1);
}

const destRoot = resolve(rootDir, 'resources', 'skills');
// Rebuild from scratch so removed/renamed skills don't linger in the package.
rmSync(destRoot, { recursive: true, force: true });
mkdirSync(destRoot, { recursive: true });

const filter = (src) => {
  const base = src.split(/[\\/]/).pop() ?? '';
  return !EXCLUDE.has(base) && !base.endsWith('.pyc');
};

for (const name of SKILLS) {
  const from = join(srcRoot, name);
  if (!existsSync(join(from, 'SKILL.md'))) {
    err(`skill "${name}" missing or has no SKILL.md at ${from}; aborting.`);
    process.exit(1);
  }
  cpSync(from, join(destRoot, name), { recursive: true, filter });
  log(`staged skill → ${name}`);
}

// Ship the license/notice alongside (CC BY-NC redistribution requirement).
for (const f of LICENSE_FILES) {
  const lf = join(srcRoot, f);
  if (existsSync(lf)) copyFileSync(lf, join(destRoot, f));
}

log(`staged ${SKILLS.length} skills → ${destRoot}`);
