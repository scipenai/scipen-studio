import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildManifest } from '../../../scripts/download-busytex-wasm.js';

describe('buildManifest', () => {
  it('returns an empty catalog in minimal mode even when extra/cjk files exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scipen-manifest-min-'));
    try {
      expect(buildManifest(tmp, true)).toEqual({
        version: 'v1.1.1',
        mode: 'minimal',
        preload: ['texlive-basic.js'],
        catalog: [],
      });

      fs.writeFileSync(path.join(tmp, 'texlive-cjk.js'), 'ok');
      fs.writeFileSync(path.join(tmp, 'texlive-cjk.data'), 'ok');
      expect(buildManifest(tmp, true)).toEqual({
        version: 'v1.1.1',
        mode: 'minimal',
        preload: ['texlive-basic.js'],
        catalog: [],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes texlive-cjk.js in full mode only when non-empty js/data files exist and skipCjk is false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scipen-manifest-full-'));
    try {
      expect(buildManifest(tmp, false)).toEqual({
        version: 'v1.1.1',
        mode: 'full',
        preload: ['texlive-basic.js'],
        catalog: ['texlive-extra.js'],
      });

      fs.writeFileSync(path.join(tmp, 'texlive-cjk.js'), '// mock');
      fs.writeFileSync(path.join(tmp, 'texlive-cjk.data'), 'bytes');
      expect(buildManifest(tmp, false)).toEqual({
        version: 'v1.1.1',
        mode: 'full',
        preload: ['texlive-basic.js'],
        catalog: ['texlive-extra.js', 'texlive-cjk.js'],
      });

      expect(buildManifest(tmp, false, true)).toEqual({
        version: 'v1.1.1',
        mode: 'full',
        preload: ['texlive-basic.js'],
        catalog: ['texlive-extra.js'],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
