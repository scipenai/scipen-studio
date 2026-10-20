/**
 * Tests for scripts/patch-busytex-pipeline.js. The real vendored pipeline is
 * not in the repo (prebuild downloads it), so a synthetic upstream file is
 * assembled from the patches' own search blocks — what matters here is the
 * apply / idempotency / fail-closed contract, which is what CI must guard.
 */

import { describe, expect, it } from 'vitest';
import { PATCHES, patchPipelineSource } from '../../scripts/patch-busytex-pipeline.js';

type Patch = { name: string; marker: string; searches: string[]; replace: string };
const patches = PATCHES as Patch[];

/** Upstream-shaped source: every pristine search block, separated by filler. */
const upstream = patches.map((p) => `// before ${p.name}\n${p.searches[0]}\n`).join('\n');

describe('patchPipelineSource', () => {
  it('applies every patch to the pristine upstream shape', () => {
    const { source, failed } = patchPipelineSource(upstream);

    expect(failed).toEqual([]);
    for (const patch of patches) expect(source).toContain(patch.marker);
  });

  it('is idempotent', () => {
    const once = patchPipelineSource(upstream).source;
    expect(patchPipelineSource(once).source).toBe(once);
  });

  it('upgrades a copy that still carries the retired rerun-skip patch', () => {
    const seam = patches.find((p) => p.name === 'pass-seam') as Patch;
    const retired = upstream.replace(seam.searches[0], seam.searches[1]);
    expect(retired).toContain('no rerun signaled by initial pass');

    const { source, failed } = patchPipelineSource(retired);
    expect(failed).toEqual([]);
    expect(source).toContain(seam.marker);
    // The fallback branch carries upstream's schedule, not the retired patch.
    expect(source).not.toContain('no rerun signaled by initial pass');
  });

  it('keeps upstream schedule as the fallback branch behind the seam', () => {
    const { source } = patchPipelineSource(upstream);
    expect(source).toContain("if (typeof this.scipen_run_passes === 'function')");
    expect(source).toContain('if (!this._needs_rerun(last_log)) {');
  });

  it('reports — instead of silently skipping — a block upstream changed', () => {
    const raw = patches.find((p) => p.name === 'raw-exit-code') as Patch;
    const drifted = upstream.replace(raw.searches[0], '        return { log };');

    const { failed, source } = patchPipelineSource(drifted);
    expect(failed).toEqual(['raw-exit-code']);
    expect(source).not.toContain(raw.marker);
  });
});
