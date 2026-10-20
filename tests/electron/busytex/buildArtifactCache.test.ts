/**
 * Tests for the incremental build-artifact cache: memory + disk persistence,
 * LRU, corruption handling, the cold-retry memory and prewarm bookkeeping.
 */

import fs from 'node:fs';
import os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BuildArtifactCache,
  isSafeArtifactPath,
  normaliseRoot,
} from '../../../src/main/busytex-process/buildArtifactCache';

let dir: string;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const keyInput = (overrides: Record<string, string> = {}) => ({
  root: '/projects/book',
  mainFile: 'main.tex',
  driver: 'xetex_bibtex8_dvipdfmx',
  assetVersion: 'v1.1.1',
  endpoint: 'https://texlive.example',
  ...overrides,
});

beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('BuildArtifactCache — storage', () => {
  it('round-trips artifacts and survives a new instance (engine restart)', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());
    cache.put(key, [
      { path: 'main.aux', bytes: bytes('\\relax') },
      { path: 'chapters/one.aux', bytes: bytes('ch') },
    ]);

    const restarted = new BuildArtifactCache(dir).get(key);
    expect(restarted?.map((a) => [a.path, text(a.bytes)])).toEqual([
      ['main.aux', '\\relax'],
      ['chapters/one.aux', 'ch'],
    ]);
  });

  it('keeps separate entries per main file, driver, asset version and endpoint', () => {
    const cache = new BuildArtifactCache(dir);
    const base = cache.key(keyInput());
    for (const change of [
      { mainFile: 'other.tex' },
      { driver: 'pdftex_bibtex8' },
      { assetVersion: 'v1.2.0' },
      { endpoint: 'https://mirror.example' },
    ]) {
      expect(cache.key(keyInput(change))).not.toBe(base);
    }
  });

  it('returns null for a corrupt entry instead of throwing', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());
    fs.mkdirSync(nodePath.join(dir, 'entries'), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, 'entries', `${key}.json`), '{not json');

    expect(cache.get(key)).toBeNull();
  });

  it('drops unsafe paths read back from disk (a tampered entry cannot escape the project)', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());
    fs.mkdirSync(nodePath.join(dir, 'entries'), { recursive: true });
    const b64 = Buffer.from('x').toString('base64');
    fs.writeFileSync(
      nodePath.join(dir, 'entries', `${key}.json`),
      JSON.stringify({
        v: 1,
        savedAt: 0,
        artifacts: [
          { path: '../../texlive/evil.sty', b64 },
          { path: '/abs.aux', b64 },
          { path: 'ok.aux', b64 },
        ],
      })
    );

    expect(new BuildArtifactCache(dir).get(key)?.map((a) => a.path)).toEqual(['ok.aux']);
  });

  it('prunes the least recently used entries beyond the cap', () => {
    const cache = new BuildArtifactCache(dir, { maxEntries: 2, maxTotalBytes: 1e9 });
    const keys = ['a.tex', 'b.tex', 'c.tex'].map((mainFile) => cache.key(keyInput({ mainFile })));
    keys.forEach((key, i) => {
      cache.put(key, [{ path: 'main.aux', bytes: bytes(String(i)) }]);
      const t = new Date(Date.now() - (keys.length - i) * 1000);
      fs.utimesSync(nodePath.join(dir, 'entries', `${key}.json`), t, t);
    });
    cache.put(keys[2], [{ path: 'main.aux', bytes: bytes('again') }]); // re-run the prune

    const onDisk = fs.readdirSync(nodePath.join(dir, 'entries'));
    expect(onDisk).toHaveLength(2);
    expect(onDisk).not.toContain(`${keys[0]}.json`);
  });

  it('works in memory only when no directory is given', () => {
    const cache = new BuildArtifactCache('');
    const key = cache.key(keyInput());
    cache.put(key, [{ path: 'main.aux', bytes: bytes('x') }]);
    expect(cache.get(key)).toHaveLength(1);
    expect(cache.warmPackages('/projects/book')).toEqual([]);
  });

  it('clear() empties memory and disk', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());
    cache.put(key, [{ path: 'main.aux', bytes: bytes('x') }]);

    expect(cache.clear()).toEqual({ removed: 1 });
    expect(cache.get(key)).toBeNull();
    expect(new BuildArtifactCache(dir).get(key)).toBeNull();
  });
});

describe('BuildArtifactCache — cold-retry memory', () => {
  it('distinguishes "never recorded" from a recorded null signature', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());

    expect(cache.coldFailure(key)).toBeUndefined();
    cache.recordColdFailure(key, null);
    expect(cache.coldFailure(key)).toBeNull();
    cache.recordColdFailure(key, '! Undefined control sequence.\nl.4 \\foo');
    expect(cache.coldFailure(key)).toBe('! Undefined control sequence.\nl.4 \\foo');
  });

  it('forgets the failure once a clean run is stored', () => {
    const cache = new BuildArtifactCache(dir);
    const key = cache.key(keyInput());
    cache.recordColdFailure(key, 'sig');
    cache.put(key, []);
    expect(cache.coldFailure(key)).toBeUndefined();
  });
});

describe('BuildArtifactCache — prewarm packages', () => {
  it('remembers per project and caps the number of projects', () => {
    const cache = new BuildArtifactCache(dir);
    for (let i = 0; i < 21; i++) cache.recordPackages(`/projects/p${i}`, [`pkg${i}.js`]);

    expect(cache.warmPackages('/projects/p20')).toEqual(['pkg20.js']);
    expect(cache.warmPackages('/projects/p0')).toEqual([]);
  });
});

describe('path helpers', () => {
  it('folds case only when asked', () => {
    expect(normaliseRoot('/Projects/Book/', true)).toBe(normaliseRoot('/projects/book', true));
    expect(normaliseRoot('/Projects/Book', false)).not.toBe(normaliseRoot('/projects/book', false));
  });

  it.each([
    ['main.aux', true],
    ['chapters/one.aux', true],
    ['../x.aux', false],
    ['a/../b.aux', false],
    ['/abs.aux', false],
    ['C:/x.aux', false],
    ['a//b.aux', false],
    ['', false],
  ])('isSafeArtifactPath(%j) is %s', (p, ok) => {
    expect(isSafeArtifactPath(p)).toBe(ok);
  });
});
