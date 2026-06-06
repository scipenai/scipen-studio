/**
 * @file check-no-cjk.js - Lint guard banning CJK characters in code.
 * @description
 *   Walks `src/` and fails CI if any .ts/.tsx/.css file contains CJK Unified
 *   Ideographs (U+4E00..U+9FFF) outside `src/renderer/src/locales/`. Lines
 *   annotated with `// allow-cjk: <reason>` are whitelisted (rare escape hatch
 *   for legitimate inline literals — e.g., regex matching user-facing CJK input).
 *
 *   Why a guard: user-facing strings must go through i18n (zh-CN.json /
 *   en-US.json); comments and logs are maintenance language and must stay
 *   single-language (English) to keep grep, git blame, and log aggregation
 *   clean. Without an automated check, every new commit risks reintroducing
 *   hardcoded CJK.
 *
 * @sideeffect Reads files synchronously; exits with code 1 on first failure.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const srcDir = resolve(rootDir, 'src');

const CJK = /[一-鿿]/;
const ALLOW_MARKER = /\/\/\s*allow-cjk:/;

// Directories ignored anywhere under src/.
const EXCLUDE_DIRS = new Set(['locales', 'node_modules']);

// File extensions checked. Other assets (svg, png, html) may legitimately hold
// brand or product text and are out of scope.
const INCLUDE_EXT = new Set(['.ts', '.tsx', '.css']);

/** @type {Array<{ path: string, line: number, content: string }>} */
const hits = [];

function scan(dir) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      scan(full);
      continue;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    if (!INCLUDE_EXT.has(ext)) continue;
    const content = readFileSync(full, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CJK.test(line)) continue;
      if (ALLOW_MARKER.test(line)) continue;
      hits.push({
        path: relative(rootDir, full).replace(/\\/g, '/'),
        line: i + 1,
        content: line.trim(),
      });
    }
  }
}

scan(srcDir);

if (hits.length === 0) {
  console.log('[check-no-cjk] OK — no CJK characters found in code (locales/ excluded).');
  process.exit(0);
}

console.error(
  `[check-no-cjk] FAIL — ${hits.length} CJK occurrence(s) in ${
    new Set(hits.map((h) => h.path)).size
  } file(s).`
);
console.error('User-facing strings must go through i18n (locales/*.json).');
console.error('Maintenance comments/logs must be English.');
console.error('Whitelist intentional inline literals with `// allow-cjk: <reason>`.');
console.error('');
for (const h of hits) {
  console.error(`  ${h.path}:${h.line}  ${h.content}`);
}
process.exit(1);
