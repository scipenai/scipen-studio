/**
 * @file patch-busytex-pipeline.js - Local patches for busytex_pipeline.js
 * @description `public/wasm/busytex/busytex_pipeline.js` is a vendored upstream
 *              asset (gitignored, re-extracted from the texlyre tarball by
 *              `download-busytex-wasm.js` on every prebuild). This module
 *              re-applies our local patches after every download, so they
 *              survive `npm run prebuild`.
 *
 * Patches:
 * 1. rerun-skip — the upstream rerun loop always runs an extra nonfinal
 *    pass between the initial pass and the final pass, even when the initial
 *    pass's log already shows no rerun is needed — every compile pays 3 full
 *    typeset passes minimum where 2 suffice. We check `_needs_rerun(last_log)`
 *    (still holding the INITIAL pass's log at this point — bibtex8/makeindex
 *    runs only destructure `exit_code`) and go straight to the final pass when
 *    no rerun was signaled. Documents that DO signal a rerun (TOC, labels,
 *    citations — undefined refs always warn on the first pass over a fresh
 *    .aux) take the unchanged upstream loop. The final pass still consumes
 *    .bbl/.ind produced by bibtex/makeindex above, so bibliographies and
 *    indices appear exactly as before.
 * 2. wasm-module-promise — upstream's reload_module does
 *    `compileStreaming ? this.wasm_module_promise : this.wasm_module_promise.then(r => r.arrayBuffer())`.
 *    That fallback is wrong in EVERY compileStreaming-less environment: the
 *    promise already resolves to a compiled WebAssembly.Module on both
 *    branches of its own constructor ternary, so calling `.arrayBuffer()`
 *    on the Module throws "r.arrayBuffer is not a function". Electron's
 *    UtilityProcess has no WebAssembly.compileStreaming, so this crashed
 *    every real compile in the packaged app. Use the promise directly.
 * 3. instantiate-passes-instance — upstream's instantiateWasm does
 *    `successCallback(compileStreaming ? output : output.instance)`, but
 *    `WebAssembly.instantiate(module, imports)` resolves an INSTANCE (not a
 *    {module, instance} ResultObject — that form is only returned when
 *    instantiating from raw bytes). With compileStreaming absent the
 *    upstream ternary passes `output.instance` === undefined and emscripten's
 *    receiveInstance crashes with "Cannot read properties of undefined
 *    (reading 'exports')". Pass `output` unconditionally — it is the
 *    Instance in both worlds (verified by runtime probe on Node 24).
 *
 * Idempotent: each patch detects its marker and skips. Fail-open: if the
 * upstream file changes shape and a search string no longer matches, we
 * print a loud warning and leave that patch unapplied — a missing patch must
 * never break the build or the engine (the wasm-module-promise patch is the
 * exception in practice: without it compiles crash where compileStreaming is
 * absent, so the CLI exit code reflects it).
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

const MARKER_RERUN = 'no rerun signaled by initial pass';

const SEARCH_RERUN = `        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {`;

const REPLACE_RERUN = `        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled && !this._needs_rerun(last_log)) {
                this.print('$ # ${MARKER_RERUN}, running final pass only');
                ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
            }
            else if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {`;

const MARKER_WASM = 'SCIPEN-PATCH: wasm module promise';

const SEARCH_WASM =
  '        const [em_module, wasm_module] = await Promise.all([this.em_module_promise, WebAssembly.compileStreaming ? this.wasm_module_promise : this.wasm_module_promise.then(r => r.arrayBuffer()), ...data_packages_js_promise]);';

const REPLACE_WASM = `        const [em_module, wasm_module] = await Promise.all([this.em_module_promise, this.wasm_module_promise /* ${MARKER_WASM}: already a compiled Module on both branches — the upstream .arrayBuffer() fallback crashes where WebAssembly.compileStreaming is absent (Electron UtilityProcess) */, ...data_packages_js_promise]);`;

const MARKER_INST = 'SCIPEN-PATCH: instantiate passes instance';

const SEARCH_INST = `WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(WebAssembly.compileStreaming ? output : output.instance)).catch(err => { throw new Error('Error while initializing BusyTex!\\n\\n' + err.toString()) });`;

const REPLACE_INST = `WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(output /* ${MARKER_INST}: instantiate(Module, imports) resolves an Instance, not a {module, instance} ResultObject — the upstream ternary passes undefined wherever WebAssembly.compileStreaming is absent (Electron UtilityProcess) */)).catch(err => { throw new Error('Error while initializing BusyTex!\\n\\n' + err.toString()) });`;

const PATCHES = [
  { name: 'rerun-skip', marker: MARKER_RERUN, search: SEARCH_RERUN, replace: REPLACE_RERUN },
  { name: 'wasm-module-promise', marker: MARKER_WASM, search: SEARCH_WASM, replace: REPLACE_WASM },
  { name: 'instantiate-passes-instance', marker: MARKER_INST, search: SEARCH_INST, replace: REPLACE_INST },
];

export function applyPipelinePatch(destDir) {
  const target = path.join(destDir, 'busytex_pipeline.js');
  if (!fs.existsSync(target)) {
    console.warn(`  ! patch-busytex-pipeline: ${target} not found, skipping`);
    return false;
  }

  let source = fs.readFileSync(target, 'utf8');
  let changed = false;
  let ok = true;

  for (const patch of PATCHES) {
    if (source.includes(patch.marker)) {
      console.log(`  ✓ busytex_pipeline.js ${patch.name} patch already applied`);
      continue;
    }
    if (!source.includes(patch.search)) {
      console.warn(
        `  ! patch-busytex-pipeline: upstream busytex_pipeline.js changed shape —` +
          ` ${patch.name} patch NOT applied. Update the ${patch.name} SEARCH block in` +
          ` scripts/patch-busytex-pipeline.js.`
      );
      ok = false;
      continue;
    }
    source = source.replace(patch.search, patch.replace);
    changed = true;
    console.log(`  ✓ busytex_pipeline.js ${patch.name} patch applied`);
  }

  if (changed) fs.writeFileSync(target, source);
  return ok;
}

// ====== CLI entry ======

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const destDir = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'public', 'wasm', 'busytex'));
  const ok = applyPipelinePatch(destDir);
  process.exit(ok === false && !fs.existsSync(path.join(destDir, 'busytex_pipeline.js')) ? 1 : 0);
}
