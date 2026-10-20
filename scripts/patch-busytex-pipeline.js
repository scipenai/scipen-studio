/**
 * @file patch-busytex-pipeline.js - Local patches for busytex_pipeline.js
 * @description `public/wasm/busytex/busytex_pipeline.js` is a vendored upstream
 *              asset (TeXlyre/texlyre-busytex, AGPL-3.0; gitignored and
 *              re-extracted from the tarball by `download-busytex-wasm.js`).
 *              This module re-applies our local patches after every
 *              download, so they survive `npm run prebuild`.
 *
 * Patches:
 * 1. pass-seam — hands the multi-pass schedule (initial pass → bibtex /
 *    makeindex → reruns → xdvipdfmx) to `this.scipen_run_passes` when the
 *    engine host has installed it (src/main/busytex-process/passPolicy.ts).
 *    Upstream's own schedule stays intact as the else-branch, and everything
 *    around it — package resolution, data-package reloads, the per-driver
 *    command table, log assembly — remains upstream's, so upstream fixes keep
 *    flowing in. Upstream's schedule decided "rerun?" by grepping the log for
 *    'rerunfilecheck', a package that hyperref always loads, so every
 *    hyperref document ran the maximum four passes. Also accepts a copy that
 *    still carries the retired `rerun-skip` patch, so existing checkouts do
 *    not need a forced re-extract.
 * 2. raw-exit-code — `_run_cmd` reports an "effective" exit code that is
 *    forced to 0 whenever stdout shows none of a few known error strings. In
 *    batchmode stdout is only the version banner, so a pass stopped by
 *    `--halt-on-error` reads as success. The patch also returns the real
 *    process status so the pass policy can stop on it.
 * 3. wasm-module-promise — upstream's reload_module does
 *    `compileStreaming ? this.wasm_module_promise : this.wasm_module_promise.then(r => r.arrayBuffer())`.
 *    That fallback is wrong in EVERY compileStreaming-less environment: the
 *    promise already resolves to a compiled WebAssembly.Module on both
 *    branches of its own constructor ternary, so calling `.arrayBuffer()`
 *    on the Module throws "r.arrayBuffer is not a function". Electron's
 *    UtilityProcess has no WebAssembly.compileStreaming, so this crashed
 *    every real compile in the packaged app. Use the promise directly.
 * 4. instantiate-passes-instance — upstream's instantiateWasm does
 *    `successCallback(compileStreaming ? output : output.instance)`, but
 *    `WebAssembly.instantiate(module, imports)` resolves an INSTANCE (not a
 *    {module, instance} ResultObject — that form is only returned when
 *    instantiating from raw bytes). With compileStreaming absent the
 *    upstream ternary passes `output.instance` === undefined and emscripten's
 *    receiveInstance crashes with "Cannot read properties of undefined
 *    (reading 'exports')". Pass `output` unconditionally — it is the
 *    Instance in both worlds (verified by runtime probe on Node 24).
 *
 * Idempotent: each patch detects its marker and skips. FAIL-CLOSED: if the
 * upstream file changed shape and a search block no longer matches, the
 * patch is reported and `applyPipelinePatch` returns false, which fails the
 * prebuild. Every patch here is load-bearing — the engine either crashes
 * (3, 4) or silently falls back to the slow, error-masking schedule (1, 2) —
 * so a mismatch must be fixed when the tarball is bumped, not shipped.
 *
 * Usage:
 *   node scripts/patch-busytex-pipeline.js [destDir]
 *   (default destDir: public/wasm/busytex; download-busytex-wasm.js calls
 *    applyPipelinePatch() automatically after extraction)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== pass-seam ======

const MARKER_SEAM = 'SCIPEN-PATCH: pass seam';

/** Upstream assets-v1.1.1 `compile()` lines 602-656, verbatim. */
const UPSTREAM_SCHEDULE_HEAD = `        let exit_code = 0;
        let last_log = '';

`;

const UPSTREAM_SCHEDULE_BODY = `        ({ exit_code, log: last_log } = run(initial, this.error_messages_fatal));

        if (exit_code == 0 && bibtex) {
            ({ exit_code } = run(bibtex8_cmd, this.error_messages_fatal));

            if (exit_code == 0 && this.read_all_text(FS, bbl_path).trim() == '') {
                this.print('$ # bibtex found no citation commands, skipping extra passes');
                bibtex = false;
            }
        }

        const makeindex_enabled = makeindex === null ? true : makeindex;
        let makeindex_active = makeindex_enabled && exit_code == 0 && FS.analyzePath(idx_path).exists && this.read_all_text(FS, idx_path).trim() != '';
        if (makeindex_active) {
            ({ exit_code } = run(makeindex_cmd, this.error_messages_fatal));
            if (exit_code == 0 && this.read_all_text(FS, ind_path).trim() == '') {
                this.print('$ # makeindex produced no index entries, skipping extra passes');
                makeindex_active = false;
            }
        } else if (makeindex === false) {
            this.print('$ # makeindex disabled by caller');
        }

        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {
                    const is_last_pass = pass === this.max_tex_passes - 1;
                    const cmd = is_last_pass ? final_cmd : nonfinal;
                    const error_messages = is_last_pass ? this.error_messages_all : this.error_messages_fatal;

                    ({ exit_code, log: last_log } = run(cmd, error_messages));

                    if (exit_code != 0)
                        break;

                    if (!this._needs_rerun(last_log)) {
                        if (cmd !== final_cmd) {
                            ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
                        }
                        break;
                    }
                }
            } else {
                this.print('$ # rerun disabled by caller, running final pass only');
                // ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
            }
        }

        if (exit_code == 0 && dvi) {
            ({ exit_code } = run(dvi, this.error_messages_all));
        }
`;

/**
 * The retired `rerun-skip` patch rewrote the head of the rerun loop. Copies
 * patched before it was retired still carry it; the seam replaces that
 * variant too and restores upstream's schedule in the fallback branch.
 */
const RETIRED_RERUN_SKIP_SEARCH = `        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {`;

const RETIRED_RERUN_SKIP_REPLACE = `        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled && !this._needs_rerun(last_log)) {
                this.print('$ # no rerun signaled by initial pass, running final pass only');
                ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
            }
            else if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {`;

const SEARCH_SEAM = UPSTREAM_SCHEDULE_HEAD + UPSTREAM_SCHEDULE_BODY;
const SEARCH_SEAM_RETIRED = SEARCH_SEAM.replace(
  RETIRED_RERUN_SKIP_SEARCH,
  RETIRED_RERUN_SKIP_REPLACE
);

const REPLACE_SEAM = `${UPSTREAM_SCHEDULE_HEAD}        // ${MARKER_SEAM} — when scipen-studio has installed \`scipen_run_passes\`
        // (src/main/busytex-process/passPolicy.ts) it owns the multi-pass
        // schedule; upstream's schedule below is the fallback, kept verbatim.
        if (typeof this.scipen_run_passes === 'function') {
            ({ exit_code, last_log } = this.scipen_run_passes({
                run, FS, files, project_dir: this.project_dir,
                initial, nonfinal, final_cmd, dvi,
                bibtex, bibtex8_cmd, makeindex, makeindex_cmd,
                aux_path, bbl_path, idx_path, ind_path,
                rerun, max_tex_passes: this.max_tex_passes,
                error_messages_all: this.error_messages_all,
                print: msg => this.print(msg),
            }));
        } else {
${UPSTREAM_SCHEDULE_BODY}        }
`;

// ====== raw-exit-code ======

const MARKER_RAW = 'SCIPEN-PATCH: raw exit code';

const SEARCH_RAW = '        return { exit_code: effective_exit_code, log };';

const REPLACE_RAW = `        return { exit_code: effective_exit_code, raw_exit_code: exit_code /* ${MARKER_RAW}: batchmode stdout is only the banner, so the effective code reports a halted pass as 0 — the pass policy stops on the real status */, log };`;

// ====== wasm-module-promise ======

const MARKER_WASM = 'SCIPEN-PATCH: wasm module promise';

const SEARCH_WASM =
  '        const [em_module, wasm_module] = await Promise.all([this.em_module_promise, WebAssembly.compileStreaming ? this.wasm_module_promise : this.wasm_module_promise.then(r => r.arrayBuffer()), ...data_packages_js_promise]);';

const REPLACE_WASM = `        const [em_module, wasm_module] = await Promise.all([this.em_module_promise, this.wasm_module_promise /* ${MARKER_WASM}: already a compiled Module on both branches — the upstream .arrayBuffer() fallback crashes where WebAssembly.compileStreaming is absent (Electron UtilityProcess) */, ...data_packages_js_promise]);`;

// ====== instantiate-passes-instance ======

const MARKER_INST = 'SCIPEN-PATCH: instantiate passes instance';

const SEARCH_INST = `WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(WebAssembly.compileStreaming ? output : output.instance)).catch(err => { throw new Error('Error while initializing BusyTex!\\n\\n' + err.toString()) });`;

const REPLACE_INST = `WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(output /* ${MARKER_INST}: instantiate(Module, imports) resolves an Instance, not a {module, instance} ResultObject — the upstream ternary passes undefined wherever WebAssembly.compileStreaming is absent (Electron UtilityProcess) */)).catch(err => { throw new Error('Error while initializing BusyTex!\\n\\n' + err.toString()) });`;

export const PATCHES = [
  {
    name: 'pass-seam',
    marker: MARKER_SEAM,
    searches: [SEARCH_SEAM, SEARCH_SEAM_RETIRED],
    replace: REPLACE_SEAM,
  },
  { name: 'raw-exit-code', marker: MARKER_RAW, searches: [SEARCH_RAW], replace: REPLACE_RAW },
  {
    name: 'wasm-module-promise',
    marker: MARKER_WASM,
    searches: [SEARCH_WASM],
    replace: REPLACE_WASM,
  },
  {
    name: 'instantiate-passes-instance',
    marker: MARKER_INST,
    searches: [SEARCH_INST],
    replace: REPLACE_INST,
  },
];

/**
 * Apply every patch to a pipeline source string. Pure, for tests.
 * @returns the patched source and the names of patches whose search block
 *          matched nothing (already-applied patches count as applied).
 */
export function patchPipelineSource(source) {
  let out = source;
  const failed = [];
  for (const patch of PATCHES) {
    if (out.includes(patch.marker)) continue;
    const search = patch.searches.find((candidate) => out.includes(candidate));
    if (!search) {
      failed.push(patch.name);
      continue;
    }
    out = out.replace(search, patch.replace);
  }
  return { source: out, failed };
}

export function applyPipelinePatch(destDir) {
  const target = path.join(destDir, 'busytex_pipeline.js');
  if (!fs.existsSync(target)) {
    console.error(`  ✗ patch-busytex-pipeline: ${target} not found`);
    return false;
  }

  const original = fs.readFileSync(target, 'utf8');
  const { source, failed } = patchPipelineSource(original);
  if (source !== original) fs.writeFileSync(target, source);

  for (const patch of PATCHES) {
    if (failed.includes(patch.name)) {
      console.error(
        `  ✗ patch-busytex-pipeline: upstream busytex_pipeline.js changed shape —` +
          ` ${patch.name} patch NOT applied. Update its search block in` +
          ` scripts/patch-busytex-pipeline.js.`
      );
    } else {
      console.log(`  ✓ busytex_pipeline.js ${patch.name} patch in place`);
    }
  }
  return failed.length === 0;
}

// ====== CLI entry ======

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const destDir = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'public', 'wasm', 'busytex'));
  process.exit(applyPipelinePatch(destDir) ? 0 : 1);
}
