/**
 * Tests for the engine-side project stager — the code that now reads a
 * project from disk instead of the renderer shipping every file over IPC.
 * Real temp directories; case sensitivity is passed explicitly so results do
 * not depend on the OS the suite runs on.
 */

import fs from 'node:fs';
import os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectStager,
  STAGE_LIMITS,
  relativeToRoot,
} from '../../../src/main/busytex-process/projectStager';

let root: string;

function write(rel: string, contents: string | Buffer, ageMs = 60_000): string {
  const abs = nodePath.join(root, rel);
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  // Older than the racy window, so the text cache may keep it.
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(abs, past, past);
  return abs;
}

function request(overrides: Partial<Parameters<ProjectStager['stage']>[0]> = {}) {
  const main = nodePath.join(root, 'main.tex');
  return {
    projectRoot: root,
    mainFileAbs: main,
    overlay: { absPath: main, contents: 'BUFFER' },
    outputDir: root,
    baseName: 'main',
    ...overrides,
  };
}

const byPath = (files: Array<{ path: string; contents: string | Uint8Array }>) =>
  Object.fromEntries(files.map((f) => [f.path, f.contents]));

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stager-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ProjectStager — what gets staged', () => {
  it('stages sources as strings and figures as bytes, skipping build artifacts and noise', () => {
    write('main.tex', 'ON DISK');
    write('chapters/one.tex', 'chapter');
    write('refs.bib', '@book{x}');
    write('main.bbl', 'committed bbl');
    write('main.aux', 'stale aux from latexmk');
    write('main.log', 'log');
    write('images/fig.png', Buffer.from([1, 2, 3]));
    write('.git/config', '[core]');
    write('node_modules/pkg/x.tex', 'nope');

    const { files, mainFile } = new ProjectStager(false).stage(request());
    const staged = byPath(files);

    expect(Object.keys(staged).sort()).toEqual([
      'chapters/one.tex',
      'images/fig.png',
      'main.bbl',
      'main.tex',
      'refs.bib',
    ]);
    // Upstream's bibtex and package resolvers only read string contents.
    expect(typeof staged['refs.bib']).toBe('string');
    expect(staged['images/fig.png']).toBeInstanceOf(Uint8Array);
    // The editor buffer wins over the file on disk.
    expect(staged['main.tex']).toBe('BUFFER');
    expect(mainFile).toBe('main.tex');
  });

  it("does not stage the compile's own output PDF as a figure", () => {
    write('main.tex', 'x');
    write('main.pdf', Buffer.from('%PDF-1.5'));
    write('figures/plot.pdf', Buffer.from('%PDF-1.4'));

    const staged = byPath(new ProjectStager(false).stage(request()).files);
    expect(Object.keys(staged).sort()).toEqual(['figures/plot.pdf', 'main.tex']);
  });

  it('keeps the disk casing when the buffer path differs only in case (Windows)', () => {
    write('Chapters/Intro.tex', 'disk');
    const bufferPath = nodePath.join(root, 'chapters', 'intro.tex');

    const { files } = new ProjectStager(true).stage(
      request({ mainFileAbs: bufferPath, overlay: { absPath: bufferPath, contents: 'BUFFER' } })
    );

    expect(byPath(files)).toEqual({ 'Chapters/Intro.tex': 'BUFFER' });
  });

  it('stages only the buffer, under its base name, without a project root', () => {
    const outside = nodePath.join(os.tmpdir(), 'loose', 'paper.tex');
    const { files, mainFile } = new ProjectStager(false).stage({
      mainFileAbs: outside,
      overlay: { absPath: outside, contents: 'BUFFER' },
      outputDir: nodePath.dirname(outside),
      baseName: 'paper',
    });

    expect(byPath(files)).toEqual({ 'paper.tex': 'BUFFER' });
    expect(mainFile).toBe('paper.tex');
  });

  it('skips figures over the per-file cap and stops adding them at the total budget', () => {
    const saved = { ...STAGE_LIMITS };
    STAGE_LIMITS.maxImageBytes = 10;
    STAGE_LIMITS.maxImageTotalBytes = 12;
    try {
      write('main.tex', 'x');
      write('a.png', Buffer.alloc(11));
      write('b.png', Buffer.alloc(8));
      write('c.png', Buffer.alloc(8));

      const { files, stats } = new ProjectStager(false).stage(request());
      const images = Object.keys(byPath(files)).filter((p) => p.endsWith('.png'));

      expect(images).toHaveLength(1);
      expect(stats.skippedLarge).toBe(1);
      expect(stats.skippedBudget).toBe(1);
    } finally {
      Object.assign(STAGE_LIMITS, saved);
    }
  });

  it('stops walking at the entry cap and reports truncation', () => {
    const saved = { ...STAGE_LIMITS };
    STAGE_LIMITS.maxEntries = 3;
    try {
      for (let i = 0; i < 6; i++) write(`f${i}.tex`, String(i));
      const { stats } = new ProjectStager(false).stage(request());
      expect(stats.truncated).toBe(true);
    } finally {
      Object.assign(STAGE_LIMITS, saved);
    }
  });

  it('does not follow links out of the project', () => {
    const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'outside-'));
    try {
      fs.writeFileSync(nodePath.join(outside, 'secret.tex'), 'outside');
      try {
        // 'junction' needs no privileges on Windows and is ignored elsewhere.
        fs.symlinkSync(outside, nodePath.join(root, 'linked'), 'junction');
      } catch {
        return; // Link creation not permitted here — nothing to test.
      }
      write('main.tex', 'x');
      const staged = byPath(new ProjectStager(false).stage(request()).files);
      expect(Object.keys(staged)).toEqual(['main.tex']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('ProjectStager — text cache', () => {
  it('serves unchanged sources from cache and re-reads edited ones', () => {
    write('main.tex', 'x');
    const chapter = write('chapter.tex', 'v1');
    const stager = new ProjectStager(false);

    const first = stager.stage(request()).stats;
    expect(first.textCacheHits).toBe(0);

    const second = stager.stage(request()).stats;
    expect(second.textCacheHits).toBe(first.textReads);

    fs.writeFileSync(chapter, 'v2, a different size');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(chapter, past, past);
    const third = stager.stage(request());
    expect(byPath(third.files)['chapter.tex']).toBe('v2, a different size');
  });

  it('does not cache a file modified moments ago (it may still be mid-save)', () => {
    write('main.tex', 'x');
    write('fresh.tex', 'just saved', 0);
    const stager = new ProjectStager(false);

    stager.stage(request());
    const again = stager.stage(request()).stats;
    // main.tex is old enough to cache; fresh.tex is read again.
    expect(again.textCacheHits).toBe(1);
  });

  it('drops the cache when the project changes', () => {
    write('main.tex', 'x');
    const stager = new ProjectStager(false);
    stager.stage(request());

    const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stager-b-'));
    try {
      const main = nodePath.join(other, 'main.tex');
      fs.writeFileSync(main, 'y');
      stager.stage(request({ projectRoot: other, mainFileAbs: main, outputDir: other }));
      expect(stager.stage(request()).stats.textCacheHits).toBe(0);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('relativeToRoot', () => {
  it('maps paths inside the root and rejects siblings sharing a prefix', () => {
    const base = nodePath.join(os.tmpdir(), 'proj');
    expect(relativeToRoot(nodePath.join(base, 'a', 'b.tex'), base, false)).toBe('a/b.tex');
    expect(relativeToRoot(nodePath.join(os.tmpdir(), 'proj2', 'b.tex'), base, false)).toBeNull();
  });

  it('folds case only when asked to', () => {
    const base = nodePath.join(os.tmpdir(), 'Proj');
    const file = nodePath.join(os.tmpdir(), 'proj', 'Main.tex');
    expect(relativeToRoot(file, base, true)).toBe('Main.tex');
    expect(relativeToRoot(file, base, false)).toBeNull();
  });
});
