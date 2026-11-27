/**
 * @file build-busytex-cjk.js — Build offline BusyTeX CJK data package (`texlive-cjk.{js,data}`)
 *
 * Packages TeX Live 2026 CJK macros (`ctex`, `xeCJK`, `zhnumber`) and the
 * 6 Fandol OpenType fonts under `/texmf/texmf-dist/` with its own `ls-R` index
 * so XeTeX compiles Chinese documents offline on first run with zero remote fetches.
 *
 * Important invariants:
 *   - Do NOT emit `// \ProvidesPackage{...}` header comments in `texlive-cjk.js`:
 *     BusytexDataPackageResolver stops at the first catalog package claiming a
 *     package name and would skip `texlive-extra.js` (which owns `fontspec.sty`).
 *   - Mount under `/texmf/texmf-dist/` (NOT `/texlive/texmf-dist/`) so the CJK
 *     `ls-R` index never collides with `texlive-basic` / `texlive-extra`.
 *
 * Usage:
 *   node scripts/build-busytex-cjk.js [destDir] [--force]
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACK_VERSION = '1';
export const MARKER = `// SCIPEN-CJK-PACK-VERSION: ${PACK_VERSION}`;
export const CACHE_DIR = path.resolve(__dirname, '..', '.busytex-cache', 'cjk');
const DEFAULT_DEST_DIR = path.resolve(__dirname, '..', 'public', 'wasm', 'busytex');
const DEFAULT_ENDPOINT = 'https://texlive2026.texlyre.org';
const CHUNK_SIZE = 2048;

/**
 * Exact 44-file CJK payload: `[kpseFormatId, filename, vfsRelPathUnderTexmfDist]`.
 * Every entry is verified HTTP 200 on TeX Live 2026 (`texlive2026.texlyre.org`).
 */
export const CJK_FILES = [
  // ctex (31 files)
  ['26', 'ctex.sty', 'tex/latex/ctex/ctex.sty'],
  ['26', 'ctexart.cls', 'tex/latex/ctex/ctexart.cls'],
  ['26', 'ctexbook.cls', 'tex/latex/ctex/ctexbook.cls'],
  ['26', 'ctexrep.cls', 'tex/latex/ctex/ctexrep.cls'],
  ['26', 'ctexbeamer.cls', 'tex/latex/ctex/ctexbeamer.cls'],
  ['26', 'ctexcap.sty', 'tex/latex/ctex/ctexcap.sty'],
  ['26', 'ctexsize.sty', 'tex/latex/ctex/ctexsize.sty'],
  ['26', 'ctexheading.sty', 'tex/latex/ctex/ctexheading.sty'],
  ['26', 'ctexhook.sty', 'tex/latex/ctex/ctexhook.sty'],
  ['26', 'ctexpatch.sty', 'tex/latex/ctex/ctexpatch.sty'],
  ['26', 'ctex-c5size.clo', 'tex/latex/ctex/ctex-c5size.clo'],
  ['26', 'ctex-cs4size.clo', 'tex/latex/ctex/ctex-cs4size.clo'],
  ['26', 'ctex.cfg', 'tex/latex/ctex/config/ctex.cfg'],
  ['26', 'ctexopts.cfg', 'tex/latex/ctex/config/ctexopts.cfg'],
  ['26', 'ctexbackend.cfg', 'tex/latex/ctex/config/ctexbackend.cfg'],
  ['26', 'ctex-name-utf8.cfg', 'tex/latex/ctex/config/ctex-name-utf8.cfg'],
  ['26', 'ctex-engine-xetex.def', 'tex/latex/ctex/engine/ctex-engine-xetex.def'],
  ['26', 'ctex-engine-pdftex.def', 'tex/latex/ctex/engine/ctex-engine-pdftex.def'],
  ['26', 'ctex-engine-luatex.def', 'tex/latex/ctex/engine/ctex-engine-luatex.def'],
  ['26', 'ctex-fontset-fandol.def', 'tex/latex/ctex/fontset/ctex-fontset-fandol.def'],
  ['26', 'ctex-fontset-windows.def', 'tex/latex/ctex/fontset/ctex-fontset-windows.def'],
  ['26', 'ctex-fontset-mac.def', 'tex/latex/ctex/fontset/ctex-fontset-mac.def'],
  ['26', 'ctex-fontset-macnew.def', 'tex/latex/ctex/fontset/ctex-fontset-macnew.def'],
  ['26', 'ctex-fontset-macold.def', 'tex/latex/ctex/fontset/ctex-fontset-macold.def'],
  ['26', 'ctex-fontset-ubuntu.def', 'tex/latex/ctex/fontset/ctex-fontset-ubuntu.def'],
  ['26', 'ctex-scheme-chinese.def', 'tex/latex/ctex/scheme/ctex-scheme-chinese.def'],
  ['26', 'ctex-scheme-chinese-article.def', 'tex/latex/ctex/scheme/ctex-scheme-chinese-article.def'],
  ['26', 'ctex-scheme-chinese-book.def', 'tex/latex/ctex/scheme/ctex-scheme-chinese-book.def'],
  ['26', 'ctex-scheme-chinese-report.def', 'tex/latex/ctex/scheme/ctex-scheme-chinese-report.def'],
  ['26', 'ctex-scheme-chinese-beamer.def', 'tex/latex/ctex/scheme/ctex-scheme-chinese-beamer.def'],
  ['26', 'ctex-scheme-plain.def', 'tex/latex/ctex/scheme/ctex-scheme-plain.def'],
  // xeCJK (5 files)
  ['26', 'xeCJK.sty', 'tex/xelatex/xecjk/xeCJK.sty'],
  ['26', 'xeCJK.cfg', 'tex/xelatex/xecjk/xeCJK.cfg'],
  ['26', 'xeCJKfntef.sty', 'tex/xelatex/xecjk/xeCJKfntef.sty'],
  ['26', 'CJKfntef.sty', 'tex/xelatex/xecjk/CJKfntef.sty'],
  ['26', 'xeCJK-listings.sty', 'tex/xelatex/xecjk/xeCJK-listings.sty'],
  // zhnumber (2 files)
  ['26', 'zhnumber.sty', 'tex/latex/zhnumber/zhnumber.sty'],
  ['26', 'zhnumber-utf8.cfg', 'tex/latex/zhnumber/zhnumber-utf8.cfg'],
  // Fandol OTF fonts (6 files)
  ['47', 'FandolSong-Regular.otf', 'fonts/opentype/public/fandol/FandolSong-Regular.otf'],
  ['47', 'FandolSong-Bold.otf', 'fonts/opentype/public/fandol/FandolSong-Bold.otf'],
  ['47', 'FandolHei-Regular.otf', 'fonts/opentype/public/fandol/FandolHei-Regular.otf'],
  ['47', 'FandolHei-Bold.otf', 'fonts/opentype/public/fandol/FandolHei-Bold.otf'],
  ['47', 'FandolKai-Regular.otf', 'fonts/opentype/public/fandol/FandolKai-Regular.otf'],
  ['47', 'FandolFang-Regular.otf', 'fonts/opentype/public/fandol/FandolFang-Regular.otf'],
];

function minValidBytes(filename) {
  return filename.toLowerCase().endsWith('.otf') ? 10000 : 1;
}

function writeAtomicSync(destPath, data) {
  const tmpPath = `${destPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, destPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
    }
  }
}

function isBuilt(jsPath, dataPath) {
  try {
    if (!fs.existsSync(jsPath) || !fs.existsSync(dataPath)) return false;
    if (fs.statSync(dataPath).size <= 0) return false;
    const fd = fs.openSync(jsPath, 'r');
    try {
      const head = Buffer.alloc(MARKER.length + 2);
      const bytesRead = fs.readSync(fd, head, 0, head.length, 0);
      const text = head.subarray(0, bytesRead).toString('utf8');
      return text.startsWith(`${MARKER}\n`) || text.startsWith(`${MARKER}\r\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function acquireFile(destDir, fmt, filename, endpoint) {
  const minSize = minValidBytes(filename);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${fmt}_${filename}`);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size >= minSize) {
    return fs.readFileSync(cachePath);
  }

  if (filename.toLowerCase().endsWith('.otf')) {
    const aliasPath = path.resolve(destDir, '..', 'font-alias', filename);
    if (fs.existsSync(aliasPath) && fs.statSync(aliasPath).size >= minSize) {
      return fs.readFileSync(aliasPath);
    }
  }

  const url = `${endpoint}/${fmt}/${encodeURIComponent(filename)}`;
  const tmpPath = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const curlArgs = [
    '-s',
    '--location',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '--max-time',
    '120',
    '-o',
    tmpPath,
    '-w',
    '%{http_code}',
  ];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    curlArgs.push('-x', proxy);
  }
  curlArgs.push(url);

  try {
    const res = spawnSync('curl', curlArgs, { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`curl failed (${res.status}) for ${url}: ${res.stderr || ''}`.trim());
    }
    const status = Number((res.stdout || '').trim());
    if (status !== 200 || !fs.existsSync(tmpPath)) {
      throw new Error(`HTTP ${status} fetching ${url}`);
    }
    const size = fs.statSync(tmpPath).size;
    if (size < minSize) {
      throw new Error(`Downloaded ${url} too small (${size} < ${minSize} bytes)`);
    }
    fs.renameSync(tmpPath, cachePath);
    return fs.readFileSync(cachePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Generate standard TeX Live `ls-R` content listing every dir and file under `/texmf/texmf-dist/`. */
function generateLsR(relPaths) {
  const dirs = new Map();
  const ensureDir = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    return dirs.get(dir);
  };

  ensureDir('.').add('ls-R');
  for (const rel of relPaths) {
    const parts = rel.split('/');
    let cur = '.';
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      ensureDir(cur).add(part);
      if (i < parts.length - 1) {
        cur = cur === '.' ? `./${part}` : `${cur}/${part}`;
        ensureDir(cur);
      }
    }
  }

  const lines = ['% ls-R -- filename database for kpathsea; do not change this line.'];
  const sortedDirs = Array.from(dirs.keys()).sort((a, b) => a.localeCompare(b));
  for (const dir of sortedDirs) {
    lines.push('', `${dir}:`);
    const entries = Array.from(dirs.get(dir)).sort((a, b) => a.localeCompare(b));
    lines.push(...entries);
  }
  lines.push('');
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Extract `var MiniLZ4 = (function() { ... })();` from `busytex.js` into a temp CommonJS module. */
function withMiniLz4(busytexJsPath, fn) {
  const src = fs.readFileSync(busytexJsPath, 'utf8');
  const start = src.indexOf('var MiniLZ4 = (function()');
  if (start < 0) {
    throw new Error(`MiniLZ4 codec not found in ${busytexJsPath}`);
  }
  const endMarker = 'return exports;\n  \n  })();';
  const altEndMarker = 'return exports;';
  let sliceEnd = src.indexOf(endMarker, start);
  if (sliceEnd >= 0) {
    sliceEnd += endMarker.length;
  } else {
    const retIdx = src.indexOf(altEndMarker, start);
    if (retIdx < 0) throw new Error(`MiniLZ4 terminator not found in ${busytexJsPath}`);
    const iifeEnd = src.indexOf('})();', retIdx);
    if (iifeEnd < 0) throw new Error(`MiniLZ4 IIFE terminator not found in ${busytexJsPath}`);
    sliceEnd = iifeEnd + '})();'.length;
  }

  const codecSource = [
    'function assert(cond, msg) { if (!cond) throw new Error("MiniLZ4 assert: " + msg); }',
    src.slice(start, sliceEnd),
    'module.exports = MiniLZ4;',
  ].join('\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scipen-minilz4-'));
  try {
    const modPath = path.join(tmpDir, 'mini-lz4.cjs');
    fs.writeFileSync(modPath, codecSource, 'utf8');
    const req = createRequire(import.meta.url);
    const MiniLZ4 = req(modPath);
    if (typeof MiniLZ4?.compressPackage !== 'function') {
      throw new Error('Extracted MiniLZ4 does not expose compressPackage()');
    }
    return fn(MiniLZ4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Replace a JS `{ ... }` object literal anchored by `prefix` using string-aware brace matching. */
function replaceBalancedObject(source, prefix, replacementJson) {
  const anchor = source.indexOf(prefix);
  if (anchor < 0) {
    throw new Error(`Wrapper template missing anchor: ${prefix}`);
  }
  const braceInPrefix = prefix.indexOf('{');
  const objStart =
    braceInPrefix >= 0 ? anchor + braceInPrefix : source.indexOf('{', anchor + prefix.length);
  if (objStart < 0 || source[objStart] !== '{') {
    throw new Error(`Opening brace not found after: ${prefix}`);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let objEnd = -1;
  for (let i = objStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        objEnd = i + 1;
        break;
      }
    }
  }
  if (objEnd < 0) {
    throw new Error(`Unbalanced object literal after: ${prefix}`);
  }
  return source.slice(0, objStart) + replacementJson + source.slice(objEnd);
}

function buildWrapperJs(basicJsPath, metadata, compressedMeta) {
  const basicJs = fs.readFileSync(basicJsPath, 'utf8');
  const modIdx = basicJs.indexOf('var Module = typeof BusytexPipeline');
  if (modIdx < 0) {
    throw new Error(`BusytexPipeline wrapper header not found in ${basicJsPath}`);
  }

  // Strip all `// \ProvidesPackage{...}` comments from `texlive-basic.js` so
  // BusytexDataPackageResolver does not short-circuit and omit `texlive-extra.js`.
  let js = `${MARKER}\n${basicJs.slice(modIdx)}`;
  js = js.replaceAll('texlive-basic.data', 'texlive-cjk.data');
  js = replaceBalancedObject(js, 'var compressedData =', JSON.stringify(compressedMeta));
  js = replaceBalancedObject(js, 'loadPackage({"files"', JSON.stringify(metadata));
  return js;
}

export function buildCjkPackage(destDir = DEFAULT_DEST_DIR, options = {}) {
  const { force = false } = options;
  const endpoint = (process.env.SCIPEN_TEXLIVE_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const jsPath = path.join(destDir, 'texlive-cjk.js');
  const dataPath = path.join(destDir, 'texlive-cjk.data');

  if (!force && isBuilt(jsPath, dataPath)) {
    console.log('  ✓ busytex CJK package already built');
    return true;
  }

  const busytexJsPath = path.join(destDir, 'busytex.js');
  const basicJsPath = path.join(destDir, 'texlive-basic.js');
  if (!fs.existsSync(busytexJsPath) || !fs.existsSync(basicJsPath)) {
    console.error(`  ✗ busytex CJK build missing busytex.js or texlive-basic.js in ${destDir}`);
    return false;
  }

  console.log(`  Building busytex CJK package (${CJK_FILES.length} files + ls-R)...`);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = [];
    for (const [fmt, filename, relPath] of CJK_FILES) {
      const buf = acquireFile(destDir, fmt, filename, endpoint);
      entries.push({ vfsPath: `/texmf/texmf-dist/${relPath}`, data: buf });
    }
    const lsR = generateLsR(CJK_FILES.map(([, , relPath]) => relPath));
    entries.push({ vfsPath: '/texmf/texmf-dist/ls-R', data: lsR });
    entries.sort((a, b) => a.vfsPath.localeCompare(b.vfsPath));

    let totalBytes = 0;
    const filesMeta = [];
    for (const entry of entries) {
      const start = totalBytes;
      totalBytes += entry.data.byteLength;
      filesMeta.push({ filename: entry.vfsPath, start, end: totalBytes });
    }
    const raw = Buffer.concat(
      entries.map((e) => e.data),
      totalBytes
    );
    const rawArrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

    const compressed = withMiniLz4(busytexJsPath, (MiniLZ4) => {
      if (MiniLZ4.CHUNK_SIZE !== CHUNK_SIZE) {
        throw new Error(`Unexpected MiniLZ4.CHUNK_SIZE: ${MiniLZ4.CHUNK_SIZE}`);
      }
      return MiniLZ4.compressPackage(rawArrayBuffer, true);
    });

    const dataBytes = Buffer.from(
      compressed.data.buffer,
      compressed.data.byteOffset,
      compressed.data.byteLength
    );
    const packageUuid = `sha256-${crypto.createHash('sha256').update(dataBytes).digest('hex')}`;
    const metadata = {
      files: filesMeta,
      remote_package_size: dataBytes.byteLength,
      package_uuid: packageUuid,
    };
    const compressedMeta = {
      data: null,
      cachedOffset: compressed.cachedOffset,
      cachedIndexes: compressed.cachedIndexes,
      cachedChunks: compressed.cachedChunks,
      offsets: compressed.offsets,
      sizes: compressed.sizes,
      successes: compressed.successes,
    };

    const wrapperJs = buildWrapperJs(basicJsPath, metadata, compressedMeta);
    writeAtomicSync(dataPath, dataBytes);
    writeAtomicSync(jsPath, wrapperJs);

    const rawMb = (raw.byteLength / 1024 / 1024).toFixed(1);
    const lz4Mb = (dataBytes.byteLength / 1024 / 1024).toFixed(1);
    console.log(`  ✓ texlive-cjk.data (${lz4Mb} MB LZ4 from ${rawMb} MB raw, ${entries.length} entries)`);
    return true;
  } catch (err) {
    for (const file of [jsPath, dataPath]) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort */
        }
      }
    }
    console.error(`  ✗ busytex CJK build failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.find((a) => !a.startsWith('--'));
  const destDir = positional ? path.resolve(positional) : DEFAULT_DEST_DIR;
  const ok = buildCjkPackage(destDir, { force });
  process.exit(ok ? 0 : 1);
}
