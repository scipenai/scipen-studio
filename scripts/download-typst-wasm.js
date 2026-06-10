/**
 * @file download-typst-wasm.js - Typst.ts WASM asset downloader
 * @description Pulls `@myriaddreamin/typst-ts-web-compiler` from npm and a
 *              minimal Typst default font set from `typst/typst-assets` on
 *              GitHub, into `public/wasm/typst-ts/`. Generates manifest.json
 *              listing the fonts the renderer worker will register at init.
 *
 *              Mirrors the shape of `download-busytex-wasm.js`: same protocol
 *              (`scipen-wasm://typst-ts/`), same prebuild integration, same
 *              `--minimal` / `--force` flags, same cache-then-extract flow.
 *
 *              Why a one-shot download script instead of an npm dependency?
 *              - WASM/font artefacts are large (~30MB wasm + ~5MB fonts) and
 *                MUST land in `public/wasm/` so electron-builder's `asarUnpack`
 *                rule unpacks them outside `app.asar`. Pulling them via
 *                `dependencies` would put them under `node_modules/` which is
 *                NOT unpacked, and the renderer Worker would fail to fetch.
 *              - The download is reproducible and version-pinned. Tarballs
 *                are cached under `.typst-ts-cache/` so repeat builds skip
 *                the network round-trip.
 *
 *              Why `curl`? Node's built-in `https` ignores `HTTPS_PROXY`.
 *              `curl` (bundled with Win10+/Mac/Linux) honours it natively.
 *
 * Usage:
 *   node scripts/download-typst-wasm.js [--no-fonts] [--force]
 *     --no-fonts  Skip the bundled font set (renderer falls back to OS fonts
 *                 via Local Font Access — only safe if the user's machine
 *                 has the required Typst defaults installed)
 *     --force     Re-download even if files exist
 *
 * Destination: public/wasm/typst-ts/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Configuration ======

/**
 * Pinned versions. Bump together: a Compiler version mismatch with the
 * font set (Typst defaults rename across releases) silently changes
 * fallback behaviour. Keep them in lockstep with `scipen-web` to avoid
 * shipping two different Typst runtimes across the products.
 */
const COMPILER_VERSION = '0.6.0';
const FONTS_TAG = 'v0.13.1';
/**
 * Noto CJK pinned via `main` (Google's repo, no tagged releases). Acceptable
 * because we cache the file by name+size — a content change at HEAD would
 * be re-pulled on `--force`, never silently swapped under a deployed build.
 */
const NOTO_CJK_REF = 'main';

const COMPILER_TARBALL_URL =
  `https://registry.npmjs.org/@myriaddreamin/typst-ts-web-compiler/-/typst-ts-web-compiler-${COMPILER_VERSION}.tgz`;

/**
 * GitHub raw-content base for typst/typst-assets at the pinned tag.
 * Each file under `files/` is fetched directly — the repo's full release
 * tarball is ~700MB which we have no interest in materialising on disk.
 *
 * NOTE: typst-assets v0.13.1 ships ONLY Latin/math fonts (NewCM, DejaVu,
 * Libertinus). CJK glyphs are NOT included upstream — `--cjk` pulls Noto
 * CJK from the separate `notofonts/noto-cjk` repository (see NOTO_CJK_BASE).
 */
const FONTS_RAW_BASE = `https://raw.githubusercontent.com/typst/typst-assets/${FONTS_TAG}/files/fonts`;

/**
 * Noto CJK SubsetOTF base. jsdelivr proxies GitHub raw files with strong
 * caching + CDN — same source `typst.app` uses for its bundled CJK.
 */
const NOTO_CJK_SERIF_SC_BASE =
  `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${NOTO_CJK_REF}/Serif/SubsetOTF/SC`;
const NOTO_CJK_SANS_SC_BASE =
  `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${NOTO_CJK_REF}/Sans/SubsetOTF/SC`;
/**
 * Mono CJK lives at the top of the Mono tree (not under SubsetOTF) — only
 * full OTFs are published. Used for code-block / table alignment in CJK
 * documents.
 */
const NOTO_CJK_SANS_MONO_SC_BASE =
  `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${NOTO_CJK_REF}/Sans/Mono`;

const DEST_DIR = path.resolve(__dirname, '..', 'public', 'wasm', 'typst-ts');
const FONTS_DEST_DIR = path.join(DEST_DIR, 'fonts');
const CACHE_DIR = path.resolve(__dirname, '..', '.typst-ts-cache');
const COMPILER_CACHE_PATH = path.join(
  CACHE_DIR,
  `typst-ts-web-compiler-${COMPILER_VERSION}.tgz`,
);

/**
 * Files we extract from the npm tarball. The tarball roots everything under
 * `package/`; `pkg/` is wasm-bindgen's standard output directory. We only
 * take the ESM + binary + bindings — the .d.ts files belong to the dev
 * surface and never reach the renderer.
 */
const COMPILER_FILES = [
  'package/pkg/typst_ts_web_compiler.mjs',
  'package/pkg/typst_ts_web_compiler_bg.wasm',
];

/**
 * Minimal Typst default font set. Picked to satisfy `typst compile` on a
 * vanilla template:
 *   - New Computer Modern (text Regular/Italic/Bold + Math) — Typst default text/math
 *   - DejaVu Sans Mono — Typst default raw/code
 * Total ~6 MB. Anything else falls through to OS fonts via Local Font
 * Access (P1) — see TypstWasmEngine doc.
 *
 * Names lifted verbatim from `typst/typst-assets/files/fonts/`. If the
 * upstream renames a file, the downloader fails loudly rather than
 * silently shipping a broken bundle.
 */
/**
 * Default Typst CLI embedded fonts. Mirrors the four families typst-cli
 * ships with — Libertinus Serif (default text), New Computer Modern
 * (alternate text), NewCM Math (default math), DejaVu Sans Mono (default
 * raw). Without Libertinus the wasm engine silently falls back to NewCM,
 * making wasm-compiled output diverge from CLI-compiled output for any
 * document that doesn't override `set text(font: ...)`.
 */
const CORE_FONTS = [
  'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Italic.otf',
  'LibertinusSerif-Bold.otf',
  'LibertinusSerif-BoldItalic.otf',
  'NewCM10-Regular.otf',
  'NewCM10-Italic.otf',
  'NewCM10-Bold.otf',
  'NewCM10-BoldItalic.otf',
  'NewCMMath-Regular.otf',
  'NewCMMath-Book.otf',
  'DejaVuSansMono.ttf',
  'DejaVuSansMono-Bold.ttf',
  'DejaVuSansMono-Oblique.ttf',
];

/**
 * Simplified Chinese font set, opt-in via `--cjk`. ~54 MB total.
 *
 * Each entry is `[filename, sourceBase]` because the noto-cjk tree splits
 * Serif/Sans/Mono into separate directories — the basename alone doesn't
 * resolve to a unique URL.
 *
 * Picks rationale:
 *   - NotoSerifSC R+B       — typst `set text(font: "Noto Serif CJK SC")` default
 *   - NotoSansSC  R+B       — typst `set text(font: "Noto Sans CJK SC")`
 *   - NotoSansMonoCJKsc R   — code blocks / table column alignment in CJK
 * Bold weights for serif/sans cover heading + emphasised text; without
 * them typst synthesises fake bold which renders poorly for CJK glyphs.
 * Mono is regular-only (16 MB) — bold mono is rare in code, not worth
 * the extra weight.
 */
const CJK_FONTS = [
  ['NotoSerifSC-Regular.otf', NOTO_CJK_SERIF_SC_BASE],
  ['NotoSerifSC-Bold.otf', NOTO_CJK_SERIF_SC_BASE],
  ['NotoSansSC-Regular.otf', NOTO_CJK_SANS_SC_BASE],
  ['NotoSansSC-Bold.otf', NOTO_CJK_SANS_SC_BASE],
  ['NotoSansMonoCJKsc-Regular.otf', NOTO_CJK_SANS_MONO_SC_BASE],
];

// ====== Argument Parsing ======

const args = process.argv.slice(2);
const noFonts = args.includes('--no-fonts');
const force = args.includes('--force');
const includeCjk = args.includes('--cjk');

// ====== Main ======

(async () => {
  console.log('Typst.ts WASM downloader');
  console.log(`  Compiler : @myriaddreamin/typst-ts-web-compiler@${COMPILER_VERSION}`);
  const fontPlanLabel = noFonts
    ? 'skipped'
    : `${CORE_FONTS.length} core${includeCjk ? ` + ${CJK_FONTS.length} CJK` : ''}`;
  console.log(`  Fonts    : typst/typst-assets@${FONTS_TAG} (${fontPlanLabel})`);
  console.log(`  Dest     : ${DEST_DIR}\n`);

  if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!noFonts && !fs.existsSync(FONTS_DEST_DIR)) {
    fs.mkdirSync(FONTS_DEST_DIR, { recursive: true });
  }

  // ---- Compiler tarball ----
  const compilerTargets = COMPILER_FILES.map((p) => path.join(DEST_DIR, path.basename(p)));
  const compilerNeeded = force || !compilerTargets.every((t) => fs.existsSync(t));

  if (compilerNeeded) {
    const cached =
      !force &&
      fs.existsSync(COMPILER_CACHE_PATH) &&
      fs.statSync(COMPILER_CACHE_PATH).size > 0;

    if (cached) {
      console.log(`✓ Using cached compiler tarball (${formatMB(fs.statSync(COMPILER_CACHE_PATH).size)})`);
    } else {
      await downloadFile(COMPILER_TARBALL_URL, COMPILER_CACHE_PATH, 'compiler tarball');
    }
    extractSelective(COMPILER_CACHE_PATH, DEST_DIR, COMPILER_FILES);
  } else {
    console.log('✓ Compiler artefacts already present, skipping');
  }

  // ---- Fonts ----
  const fontFiles = [];
  if (!noFonts) {
    // Combined work-list: core (typst-assets, ~600 KB each) + optional CJK
    // (notofonts/noto-cjk via jsdelivr, ~8-12 MB each). Pre-resolved URLs
    // keep the download loop a single homogeneous flow.
    const plan = [
      ...CORE_FONTS.map((name) => ({ name, base: FONTS_RAW_BASE })),
      ...(includeCjk ? CJK_FONTS.map(([name, base]) => ({ name, base })) : []),
    ];
    const missing = plan.filter(({ name }) =>
      force || !fs.existsSync(path.join(FONTS_DEST_DIR, name))
    );
    if (missing.length === 0) {
      console.log('✓ Fonts already present, skipping');
    } else {
      console.log(`Downloading ${missing.length} font files ...`);
      // Sequential — keeps the upstream hosts happy and the progress
      // output readable. CJK files are 8-12 MB each; parallelising would
      // hammer jsdelivr without meaningful speedup over a typical link.
      for (const { name, base } of missing) {
        await downloadFile(`${base}/${name}`, path.join(FONTS_DEST_DIR, name), `font ${name}`);
      }
    }
    for (const { name } of plan) fontFiles.push(name);
  }

  writeManifest(DEST_DIR, fontFiles);
  console.log(`\n✓ Done. typst-ts assets staged in ${DEST_DIR}`);
})().catch((err) => {
  console.error(`\n✗ Failed: ${err.message}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    console.error(`  (proxy env: HTTPS_PROXY=${process.env.HTTPS_PROXY || '<unset>'})`);
  } else {
    console.error(`  Hint: npm/GitHub raw can be slow without a proxy.`);
    console.error(`  Set HTTPS_PROXY=http://127.0.0.1:<port> and re-run.`);
  }
  process.exit(1);
});

// ====== Helpers ======

function downloadFile(url, destPath, label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`  → ${label} ... `);

    const curlArgs = [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry', '3',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      '--max-time', '600',
      '-o', destPath,
      url,
    ];

    const proc = spawn('curl', curlArgs, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });

    proc.on('error', (err) => {
      reject(new Error(`curl spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        process.stdout.write(`${formatMB(size)}\n`);
        resolve();
      } else {
        try { fs.unlinkSync(destPath); } catch {}
        reject(new Error(`curl exited with code ${code} for ${url}`));
      }
    });
  });
}

/**
 * Selectively extract files from the npm tarball, stripping the leading
 * `package/pkg/` so the wasm and mjs land flat under `DEST_DIR`. Uses the
 * same System32 tar.exe path-handling pattern as `download-busytex-wasm.js`
 * — see that file for the Windows tar-binary caveat.
 */
function extractSelective(tarballPath, destDir, wantedTarPaths) {
  console.log(`Extracting ${wantedTarPaths.length} compiler files ...`);

  const tarBinary = resolveTarBinary();
  const isWin = process.platform === 'win32';
  const tarballArg = isWin ? tarballPath.replace(/\//g, '\\') : tarballPath;
  const destArg = isWin ? destDir.replace(/\//g, '\\') : destDir;

  // `--strip-components 2` peels `package/pkg/`, leaving the basename only.
  const result = spawnSync(
    tarBinary,
    ['-xzf', tarballArg, '-C', destArg, '--strip-components=2', ...wantedTarPaths],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    throw new Error(`tar exited with code ${result.status}`);
  }
  for (const p of wantedTarPaths) {
    const dest = path.join(destDir, path.basename(p));
    if (!fs.existsSync(dest)) {
      throw new Error(`Expected file missing after extract: ${dest}`);
    }
    const size = fs.statSync(dest).size;
    console.log(`  ✓ ${path.basename(p)} (${formatMB(size)})`);
  }
}

function resolveTarBinary() {
  if (process.platform !== 'win32') return 'tar';
  const system32Tar = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'tar.exe',
  );
  return fs.existsSync(system32Tar) ? system32Tar : 'tar';
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Manifest schema mirrors BusyTeX's: a single JSON the renderer worker
 * fetches at init to discover what's on disk. The Studio worker iterates
 * `fonts` and registers each via `builder.add_raw_font()`.
 */
function writeManifest(destDir, fontFiles) {
  const manifest = {
    compilerVersion: COMPILER_VERSION,
    fontsTag: FONTS_TAG,
    compiler: {
      mjs: 'typst_ts_web_compiler.mjs',
      wasm: 'typst_ts_web_compiler_bg.wasm',
    },
    // Relative to `scipen-wasm://typst-ts/fonts/`. Empty when --no-fonts.
    fonts: fontFiles,
  };
  const manifestPath = path.join(destDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  ✓ manifest.json (compiler=${COMPILER_VERSION}, fonts=${fontFiles.length})`);
}
