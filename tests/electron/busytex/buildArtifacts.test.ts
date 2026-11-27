/**
 * Tests for the build-artifact definition shared by the pass policy
 * (convergence fingerprint) and the incremental cache (what gets carried).
 */

import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_MAX_FILE_BYTES,
  type ArtifactFs,
  fingerprintArtifacts,
  isArtifactPath,
  listArtifacts,
} from '../../../src/main/busytex-process/buildArtifacts';

const DIR = 0o040000;
const FILE = 0o100000;

/** In-memory stand-in for the emscripten FS calls the module uses. */
function memfs(files: Record<string, string | number>): ArtifactFs {
  const content = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  for (const [path, value] of Object.entries(files)) {
    if (typeof value === 'number') {
      sizes.set(path, value);
      content.set(path, new Uint8Array(0));
    } else {
      const bytes = new TextEncoder().encode(value);
      content.set(path, bytes);
      sizes.set(path, bytes.byteLength);
    }
  }
  const isDirPath = (path: string) =>
    [...content.keys()].some((file) => file.startsWith(`${path}/`));
  return {
    analyzePath: (path) => ({ exists: content.has(path) || isDirPath(path) }),
    readdir: (dir) => {
      const names = new Set<string>(['.', '..']);
      for (const file of content.keys()) {
        if (file.startsWith(`${dir}/`)) names.add(file.slice(dir.length + 1).split('/')[0]);
      }
      return [...names];
    },
    stat: (path) => ({ mode: content.has(path) ? FILE : DIR, size: sizes.get(path) ?? 0 }),
    isDir: (mode) => mode === DIR,
    isFile: (mode) => mode === FILE,
    readFile: (path) => content.get(path) ?? new Uint8Array(0),
  };
}

const NO_SOURCES = new Set<string>();

describe('isArtifactPath', () => {
  it.each([
    'main.aux',
    'main.toc',
    'main.out',
    'main.lof',
    'main.lol', // \lstlistoflistings — the case an allow-list misses
    'main.loa',
    'main.tdo',
    'main.lop', // user-defined float list
    'main.bbl',
    'main.ind',
    'chapters/ch1.aux',
  ])('carries %s', (path) => {
    expect(isArtifactPath(path)).toBe(true);
  });

  it.each([
    'main.log',
    'main.xdv',
    'main.pdf',
    'main.synctex.gz',
    'main.synctex(busy)',
    'main.blg',
    'main.fls',
    'main.idx', // rewritten every pass; a stale one would revive makeindex
    'main.glo',
    'main.tex',
    'style.sty',
    'refs.bib',
    'images/fig.png',
    'README',
  ])('does not carry %s', (path) => {
    expect(isArtifactPath(path)).toBe(false);
  });
});

describe('listArtifacts', () => {
  it('walks subdirectories and skips staged sources even with artifact extensions', () => {
    const fs = memfs({
      '/p/main.tex': 'x',
      '/p/main.aux': 'aux',
      '/p/main.bbl': 'committed',
      '/p/main.log': 'log',
      '/p/chapters/ch1.aux': 'ch1',
      '/p/images/a.png': 'png',
    });
    const paths = listArtifacts(fs, '/p', new Set(['main.tex', 'main.bbl', 'images/a.png'])).map(
      (a) => a.path
    );

    expect(paths).toEqual(['chapters/ch1.aux', 'main.aux']);
  });

  it('skips files over the per-file cap', () => {
    const fs = memfs({ '/p/huge.aux': ARTIFACT_MAX_FILE_BYTES + 1, '/p/main.aux': 'ok' });
    expect(listArtifacts(fs, '/p', NO_SOURCES).map((a) => a.path)).toEqual(['main.aux']);
  });

  it('returns nothing for a missing root', () => {
    expect(listArtifacts(memfs({}), '/missing', NO_SOURCES)).toEqual([]);
  });
});

describe('fingerprintArtifacts', () => {
  it('is stable for identical artifacts and moves when any of them changes', () => {
    const base = { '/p/main.aux': 'a', '/p/main.toc': 't', '/p/main.log': 'run 1' };
    const same = { ...base, '/p/main.log': 'run 2 — logs never count' };
    const moved = { ...base, '/p/main.toc': 't2' };

    const fp = (files: Record<string, string>) =>
      fingerprintArtifacts(memfs(files), '/p', NO_SOURCES);
    expect(fp(same)).toBe(fp(base));
    expect(fp(moved)).not.toBe(fp(base));
  });

  it('notices an artifact appearing for the first time', () => {
    const before = fingerprintArtifacts(memfs({ '/p/main.tex': 'x' }), '/p', new Set(['main.tex']));
    const after = fingerprintArtifacts(
      memfs({ '/p/main.tex': 'x', '/p/main.aux': '\\relax' }),
      '/p',
      new Set(['main.tex'])
    );
    expect(after).not.toBe(before);
  });
});
