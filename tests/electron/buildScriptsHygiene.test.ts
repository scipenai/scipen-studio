/**
 * Static and runtime cross-platform hygiene guards for `scripts/`.
 *
 * Ensures Windows, macOS, and Linux release builds never regress on Unix-only
 * env vars (`TMPDIR`, `HOME`), hardcoded `/tmp` paths, or PowerShell Archive
 * mismatches.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMiniLz4 } from '../../scripts/patch-busytex-fonts.js';

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

function listScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScriptFiles(full));
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('build scripts cross-platform hygiene', () => {
  const scriptFiles = listScriptFiles(SCRIPTS_DIR);

  it('never relies on TMPDIR, HOME, hardcoded /tmp, or PowerShell Expand-Archive', () => {
    expect(scriptFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const file of scriptFiles) {
      const rel = path.relative(SCRIPTS_DIR, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));

      if (/\bprocess\.env\.TMPDIR\b/.test(code)) {
        violations.push(`${rel}: uses process.env.TMPDIR instead of os.tmpdir()`);
      }
      if (/\bprocess\.env\.HOME\b/.test(code)) {
        violations.push(`${rel}: uses process.env.HOME instead of os.homedir()`);
      }
      if (/['"`]\/tmp(?:\/|['"`])/.test(code)) {
        violations.push(`${rel}: hardcodes /tmp instead of os.tmpdir()`);
      }
      if (/Expand-Archive|\bpowershell\b/i.test(code)) {
        violations.push(`${rel}: invokes PowerShell / Expand-Archive instead of extract-zip`);
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('patch-busytex-fonts loadMiniLz4', () => {
  let scratchDir: string;
  let origTmpdir: string | undefined;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scipen-lz4-test-'));
    origTmpdir = process.env.TMPDIR;
    Reflect.deleteProperty(process.env, 'TMPDIR');
  });

  afterEach(() => {
    if (origTmpdir !== undefined) {
      process.env.TMPDIR = origTmpdir;
    } else {
      Reflect.deleteProperty(process.env, 'TMPDIR');
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('loads MiniLZ4 with TMPDIR unset and removes its temp dir', () => {
    const fakeBusytex = path.join(scratchDir, 'busytex.js');
    fs.writeFileSync(
      fakeBusytex,
      [
        '// header',
        'var MiniLZ4 = (function() { return { CHUNK_SIZE: 2048, tag: "ok" }; })();',
        "if (typeof module != 'undefined') module.exports = {};",
        '',
      ].join('\n'),
      'utf8'
    );

    const beforeDirs = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('minilz4-'))
    );
    const mod = loadMiniLz4(fakeBusytex);
    const afterDirs = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('minilz4-') && !beforeDirs.has(name));

    expect(mod).toMatchObject({ CHUNK_SIZE: 2048, tag: 'ok' });
    expect(afterDirs).toEqual([]);
  });
});
