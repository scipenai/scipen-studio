/**
 * @file patch-busytex-fonts.js — bake system-font aliases into the BusyTeX
 *          texlive-basic data package.
 * @description Documents written on machines with system fonts (pdf2tex
 *              output et al.) reference families the wasm engine can never
 *              have ('SimSun', 'Source Han Serif CN', 'Times New Roman', …).
 *              fontspec's \IfFontExistsTF chains fall through every option
 *              and die on the final unconditional fallback. We proved by
 *              experiment that the engine's fontconfig initializes during
 *              engine load with /texlive/fonts.conf baked into THIS data
 *              package — post-load config rewrites are invisible to it — so
 *              the only working fix is to bake the fix into the package.
 *
 * What it does (append-only; every original chunk offset stays valid):
 *   1. Decompress the final partial LZ4 chunk, pad it to a full chunk and
 *      re-store it (compressed) so new content starts chunk-aligned.
 *   2. Append font files (Fandol + TeX Gyre, downloaded from the TeX Live
 *      endpoint into public/wasm/font-alias/ on first run) under
 *      /texlive/texmf-dist/fonts/opentype/scipen/ — inside the directory
 *      fonts.conf already scans, so fontconfig indexes their real internal
 *      families ('FandolSong', 'TeXGyreTermes', 'TeXGyreHeros') at init.
 *   3. Append a NEW /texlive/fonts.conf entry (the LZ4 loader creates FS
 *      nodes in manifest order, so the later entry wins) carrying <match>
 *      alias rules that rewrite the known system families onto those
 *      engine families.
 *   4. Extend compressedData offsets/sizes/successes; refresh
 *      remote_package_size and package_uuid.
 *
 * The LZ4 codec is re-extracted from busytex.js on every run so it always
 * matches the shipped engine.
 *
 * Idempotent: re-running detects the scipen marker entry and skips.
 * Fail-open: any format surprise prints a loud warning and leaves the
 * package untouched — a missing bake must never break the build.
 *
 * Usage:
 *   node scripts/patch-busytex-fonts.js [destDir]
 *   (default destDir: public/wasm/busytex; download-busytex-wasm.js calls
 *    applyFontPatch() automatically after extraction)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const CHUNK_SIZE = 2048;
// Idempotency marker: one of the filenames the bake itself appends (the
// clones are named after TARGET families — never the base font's name).
const MARKER_FILE = '/texlive/texmf-dist/fonts/opentype/scipen/SimSun.otf';
const FONT_ENDPOINT = process.env.SCIPEN_TEXLIVE_ENDPOINT || 'https://texlive2026.texlyre.org';

/** font clone groups: for every `families` name we emit a COPY of the base
 *  font whose internal family name is rewritten to that name — the engine's
 *  minimal fontconfig build does no config substitution (<match>/<alias>
 *  proved inert), so the system font names must EXIST as real indexed
 *  families. Glyphs come from the base font, which is exactly the intent
 *  (CJK text renders with Fandol, Times-like text with TeX Gyre Termes). */
const FONT_CLONES = [
  {
    base: 'FandolSong-Regular.otf',
    families: ['SimSun', '宋体', 'FangSong', '仿宋'],
  },
  {
    base: 'FandolHei-Regular.otf',
    families: ['SimHei', '黑体', 'Microsoft YaHei', '微软雅黑'],
  },
  {
    base: 'FandolKai-Regular.otf',
    families: ['KaiTi', '楷体'],
  },
  {
    base: 'texgyretermes-regular.otf',
    families: ['Times New Roman'],
  },
  {
    base: 'texgyreheros-regular.otf',
    families: ['Arial', 'Arial Unicode MS'],
  },
];

const BASE_FONTS = [...new Set(FONT_CLONES.map((g) => g.base))];

/** Extract the engine's own MiniLZ4 codec (vendored inside busytex.js) as a
 *  temporary CommonJS module — always matches the shipped engine. */
function loadMiniLz4(busytexJsPath) {
  const src = fs.readFileSync(busytexJsPath, 'utf8');
  const start = src.indexOf('var MiniLZ4 = (function()');
  const end = src.indexOf('if (typeof module != \'undefined\')', start);
  if (start < 0 || end < 0) return null;
  const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'minilz4-'));
  const tmp = path.join(tmpDir, 'minilz4.cjs');
  // `assert` is a module-local helper in busytex.js, defined above the codec.
  fs.writeFileSync(
    tmp,
    'function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }\n' +
      src.slice(start, end) +
      '\nmodule.exports = MiniLZ4;'
  );
  const mod = require(tmp);
  if (mod.CHUNK_SIZE !== CHUNK_SIZE) {
    throw new Error(`MiniLZ4.CHUNK_SIZE ${mod.CHUNK_SIZE} != expected ${CHUNK_SIZE}`);
  }
  return mod;
}

/** Extract a balanced-brace object literal; `from` points at the '{'.
 *  String-literal aware: braces inside "…" never affect the depth. */
function extractBraced(src, from) {
  let depth = 0;
  let inStr = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"') {
      inStr = '"';
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

/** Parse the internal family name (nameID 1, platform 3) of an OTF buffer. */
function readOtfFamily(buf) {
  const numTables = buf.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      nameOff = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (nameOff < 0) return null;
  const count = buf.readUInt16BE(nameOff + 2);
  const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    if (buf.readUInt16BE(rec) === 3 && buf.readUInt16BE(rec + 6) === 1) {
      const len = buf.readUInt16BE(rec + 8);
      const off = buf.readUInt16BE(rec + 10);
      return buf.subarray(strOff + off, strOff + off + len).swap16().toString('utf16le').trim();
    }
  }
  return null;
}

/** Rewrite an sfnt font's family name: every name-table record with
 *  nameID 1/4/16 gets `newFamily` (platform 3 → UTF-16BE, platform 1 →
 *  latin1), nameID 6 gets the spacing-stripped form. The name table is
 *  re-serialized; if it grows it is relocated to the end of the file.
 *  Checksums are left stale — neither fontconfig nor FreeType enforces
 *  them for name lookup. */
function cloneFontWithFamily(base, newFamily) {
  const buf = Buffer.from(base);
  const numTables = buf.readUInt16BE(4);
  let nameOff = -1;
  let nameLen = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      nameOff = buf.readUInt32BE(rec + 8);
      nameLen = buf.readUInt32BE(rec + 12);
      break;
    }
  }
  if (nameOff < 0) throw new Error('name table missing');
  const format = buf.readUInt16BE(nameOff);
  const count = buf.readUInt16BE(nameOff + 2);
  const storageRel = buf.readUInt16BE(nameOff + 4);

  const psName = newFamily.replace(/[^A-Za-z0-9-]/g, '') || newFamily;
  const records = [];
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platformId = buf.readUInt16BE(rec);
    const nameId = buf.readUInt16BE(rec + 6);
    let value = buf.subarray(nameOff + storageRel + buf.readUInt16BE(rec + 10),
      nameOff + storageRel + buf.readUInt16BE(rec + 10) + buf.readUInt16BE(rec + 8));
    if (nameId === 1 || nameId === 4 || nameId === 16) {
      value = platformId === 3
        ? Buffer.from(newFamily, 'utf16le').swap16()
        : Buffer.from(newFamily, 'latin1');
    } else if (nameId === 6) {
      value = platformId === 3
        ? Buffer.from(psName, 'utf16le').swap16()
        : Buffer.from(psName, 'latin1');
    }
    records.push({ platformId, encodingId: buf.readUInt16BE(rec + 2), languageId: buf.readUInt16BE(rec + 4), nameId, value });
  }

  // Re-serialize the name table with rebuilt string storage.
  const headerSize = 6 + records.length * 12;
  const storage = [];
  let storageLen = 0;
  for (const r of records) {
    r.newOff = storageLen;
    storage.push(r.value);
    storageLen += r.value.length;
  }
  const newName = Buffer.alloc(headerSize + storageLen);
  newName.writeUInt16BE(format, 0);
  newName.writeUInt16BE(records.length, 2);
  newName.writeUInt16BE(headerSize, 4);
  records.forEach((r, i) => {
    const rec = 6 + i * 12;
    newName.writeUInt16BE(r.platformId, rec);
    newName.writeUInt16BE(r.encodingId, rec + 2);
    newName.writeUInt16BE(r.languageId, rec + 4);
    newName.writeUInt16BE(r.nameId, rec + 6);
    newName.writeUInt16BE(r.value.length, rec + 8);
    newName.writeUInt16BE(r.newOff, rec + 10);
    r.value.copy(newName, headerSize + r.newOff);
  });

  if (newName.length <= nameLen) {
    newName.copy(buf, nameOff);
    if (newName.length < nameLen) buf.subarray(nameOff + newName.length, nameOff + nameLen).fill(0);
  } else {
    const appended = buf.length;
    const out = Buffer.concat([buf, newName]);
    // Update the directory entry: locate it again by tag scan.
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (out.toString('latin1', rec, rec + 4) === 'name') {
        out.writeUInt32BE(appended, rec + 8);
        out.writeUInt32BE(newName.length, rec + 12);
        break;
      }
    }
    return out;
  }
  return buf;
}

function fetchFont(dir, file) {
  const dest = path.join(dir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;
  const url = `${FONT_ENDPOINT}/26/${file}`;
  console.log(`  · downloading ${file} …`);
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const args = ['-s', '--max-time', '120', '-o', dest, '-w', '%{http_code}'];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const status = Number(out) || 0;
  if (status !== 200 || !fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    throw new Error(`fetch ${url} → HTTP ${status}`);
  }
  return dest;
}

/** Compress one 2048-byte chunk the way the engine's compressPackage does:
 *  returns {bytes, stored} — stored=true means the chunk is raw and the
 *  reader skips decompression. */
function compressChunk(lz4, plain) {
  if (plain.length === CHUNK_SIZE) {
    const bound = lz4.compressBound(plain.length);
    const dst = new Uint8Array(bound);
    const size = lz4.compress(plain, dst);
    if (size > 0) {
      const round = lz4.uncompress(dst.subarray(0, size), new Uint8Array(CHUNK_SIZE));
      if (round === CHUNK_SIZE) return { bytes: Buffer.from(dst.subarray(0, size)), stored: false };
    }
  }
  const stored = Buffer.alloc(CHUNK_SIZE, 0);
  plain.copy(stored, 0);
  return { bytes: stored, stored: true };
}

export function applyFontPatch(destDir) {
  const jsPath = path.join(destDir, 'texlive-basic.js');
  const dataPath = path.join(destDir, 'texlive-basic.data');
  if (!fs.existsSync(jsPath) || !fs.existsSync(dataPath)) {
    console.warn(`  ! patch-busytex-fonts: ${jsPath} / ${dataPath} not found, skipping`);
    return false;
  }

  let js = fs.readFileSync(jsPath, 'utf8');
  const data = fs.readFileSync(dataPath);
  if (js.includes(MARKER_FILE)) {
    console.log('  ✓ busytex font bake already applied');
    return true;
  }

  // ---- locate and parse the two literals (brace-balanced, not regex) ----
  // The manifest call is `loadPackage({"files": …})` — the FIRST loadPackage
  // in the file is the LZ4 module's internal one ({'metadata': …}), so anchor
  // on the files key.
  const manifestKey = 'loadPackage({"files"';
  const manifestFrom = js.indexOf(manifestKey);
  if (manifestFrom < 0) {
    console.warn('  ! patch-busytex-fonts: loadPackage manifest not found — skipping');
    return false;
  }
  const manifestStart = manifestFrom + 'loadPackage('.length;
  const manifestJson = extractBraced(js, manifestStart);
  const meta = JSON.parse(manifestJson);
  const manifestEnd = manifestStart + manifestJson.length; // just past '}'

  const cdKey = 'var compressedData = ';
  const cdFrom = js.indexOf(cdKey);
  if (cdFrom < 0) {
    console.warn('  ! patch-busytex-fonts: compressedData literal not found — skipping');
    return false;
  }
  const cdStart = cdFrom + cdKey.length - 1;
  const cdJson = extractBraced(js, cdStart);
  const cd = JSON.parse(cdJson);
  const cdEnd = cdStart + cdJson.length; // just past '}'
  if (!Array.isArray(cd.offsets) || !Array.isArray(cd.sizes) || !Array.isArray(cd.successes)) {
    console.warn('  ! patch-busytex-fonts: unexpected compressedData shape — skipping');
    return false;
  }

  const lz4 = loadMiniLz4(path.join(destDir, 'busytex.js'));
  if (!lz4) {
    console.warn('  ! patch-busytex-fonts: MiniLZ4 codec not found in busytex.js — skipping');
    return false;
  }

  const lastFile = meta.files[meta.files.length - 1];
  const totalUncompressed = lastFile.end;
  const lastChunkIndex = Math.floor((totalUncompressed - 1) / CHUNK_SIZE);
  if (cd.offsets.length !== lastChunkIndex + 1) {
    console.warn(
      `  ! patch-busytex-fonts: offsets (${cd.offsets.length}) != expected chunks (${lastChunkIndex + 1}) — skipping`
    );
    return false;
  }

  // ---- build the cloned fonts ----
  const fontDir = path.join(destDir, '..', 'font-alias');
  fs.mkdirSync(fontDir, { recursive: true });
  const appendedFiles = []; // {filename, bytes}
  const families = [];
  try {
    for (const group of FONT_CLONES) {
      const baseBuf = fs.readFileSync(fetchFont(fontDir, group.base));
      const baseFamily = readOtfFamily(baseBuf);
      if (!baseFamily) throw new Error(`family parse failed for ${group.base}`);
      for (const family of group.families) {
        appendedFiles.push({
          filename: `/texlive/texmf-dist/fonts/opentype/scipen/${family.replace(/[^A-Za-z0-9\u4e00-\u9fff-]+/g, '_')}.otf`,
          bytes: cloneFontWithFamily(baseBuf, family),
        });
        families.push(family);
      }
    }
  } catch (err) {
    console.warn(`  ! patch-busytex-fonts: font fetch/clone failed (${err.message}) — skipping bake`);
    return false;
  }

  // ---- rebuild the .data (append-only chunk surgery) ----
  const head = data.subarray(0, cd.offsets[lastChunkIndex]);

  // Original final chunk: decompress, pad to a full chunk, recompress.
  const lastOrig = data.subarray(
    cd.offsets[lastChunkIndex],
    cd.offsets[lastChunkIndex] + cd.sizes[lastChunkIndex]
  );
  let lastPlain;
  if (cd.successes[lastChunkIndex]) {
    {
      const out = new Uint8Array(CHUNK_SIZE);
      const n = lz4.uncompress(lastOrig, out);
      lastPlain = Buffer.from(out.subarray(0, n));
    }
  } else {
    lastPlain = Buffer.from(lastOrig.subarray(0, Math.min(CHUNK_SIZE, lastOrig.length)));
  }
  if (lastPlain.length > CHUNK_SIZE) {
    console.warn('  ! patch-busytex-fonts: last chunk larger than CHUNK_SIZE — skipping');
    return false;
  }
  const paddedLast = Buffer.alloc(CHUNK_SIZE, 0);
  lastPlain.copy(paddedLast, 0);

  // New content stream (the appended files, contiguous), chunked + compressed.
  const content = Buffer.concat(appendedFiles.map((f) => f.bytes));
  const blocks = [{ bytes: paddedLast, stored: false }];
  blocks[0] = compressChunk(lz4, paddedLast);
  for (let off = 0; off < content.length; off += CHUNK_SIZE) {
    blocks.push(compressChunk(lz4, content.subarray(off, Math.min(off + CHUNK_SIZE, content.length))));
  }

  // ---- extend offsets/sizes/successes and rebuild the tail ----
  const newOffsets = [...cd.offsets];
  const newSizes = [...cd.sizes];
  const newSuccesses = [...cd.successes];
  const tailParts = [];
  let cursor = cd.offsets[lastChunkIndex];
  for (let i = 0; i < blocks.length; i++) {
    newOffsets[lastChunkIndex + i] = cursor;
    newSizes[lastChunkIndex + i] = blocks[i].bytes.length;
    newSuccesses[lastChunkIndex + i] = blocks[i].stored ? 0 : 1;
    tailParts.push(blocks[i].bytes);
    cursor += blocks[i].bytes.length;
  }
  // The 2-chunk decompression scratch area, like the original tail.
  const scratch = Buffer.alloc(CHUNK_SIZE * 2, 0);
  tailParts.push(scratch);
  cursor += scratch.length;

  const newData = Buffer.concat([head, ...tailParts]);
  if (newData.length !== cursor) throw new Error('data rebuild size mismatch');

  // ---- patch the manifest: appended files start at the next chunk boundary
  //      of the global uncompressed stream ----
  let start = (lastChunkIndex + 1) * CHUNK_SIZE;
  for (const f of appendedFiles) {
    meta.files.push({ filename: f.filename, start, end: start + f.bytes.length });
    start += f.bytes.length;
  }
  meta.remote_package_size = newData.length;
  meta.package_uuid = 'sha256-' + crypto.createHash('sha256').update(newData).digest('hex');

  // ---- write back: manifest and compressedData literals replaced in place ----
  fs.writeFileSync(dataPath, newData);
  js =
    js.slice(0, manifestStart) +
    JSON.stringify(meta) +
    js.slice(manifestEnd);
  js =
    js.slice(0, cdStart) +
    JSON.stringify({
      ...cd,
      cachedOffset: cursor - CHUNK_SIZE * 2,
      offsets: newOffsets,
      sizes: newSizes,
      successes: newSuccesses,
    }) +
    js.slice(cdEnd);
  fs.writeFileSync(jsPath, js);

  console.log(
    `  ✓ busytex font bake applied: ${appendedFiles.length} font clones ` +
      `(${families.length} system families from ${new Set(FONT_CLONES.map((g) => g.base)).size} base fonts), ` +
      `.data ${data.length} → ${newData.length} bytes`
  );
  return true;
}

// ====== CLI entry ======

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const destDir = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'public', 'wasm', 'busytex'));
  const ok = applyFontPatch(destDir);
  process.exit(ok === false && !fs.existsSync(path.join(destDir, 'texlive-basic.js')) ? 1 : 0);
}
