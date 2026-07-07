import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseSynctex } from '../../src/renderer/src/services/synctex/synctexParser';

/**
 * Fixture produced by `xelatex -synctex=1` on a 3-paragraph article whose
 * source records `main.tex` boxes on page 1 (Input path
 * `/tmp/synctex-fix/./main.tex`). See tests/renderer/fixtures/sample.synctex.gz.
 */
const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.synctex.gz')));

describe('parseSynctex (real xelatex fixture)', () => {
  it('parses a gzipped .synctex.gz without throwing', () => {
    expect(() => parseSynctex(fixture)).not.toThrow();
  });

  it('forward: resolves a source line to page 1 with finite rects', () => {
    const map = parseSynctex(fixture);
    // Find any body line that carries boxes (content sits around lines 3-8).
    let hit: ReturnType<typeof map.forward> = null;
    let hitLine = 0;
    for (let line = 3; line <= 8; line++) {
      const r = map.forward('main.tex', line);
      if (r) {
        hit = r;
        hitLine = line;
        break;
      }
    }
    expect(hit, 'expected at least one body line to resolve').not.toBeNull();
    expect(hit?.page).toBe(1);
    expect(hit?.rects.length).toBeGreaterThan(0);
    for (const rect of hit!.rects) {
      for (const v of [rect.x, rect.y, rect.width, rect.height]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // Coordinates are in PDF points on a standard page.
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x).toBeLessThan(700);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeLessThan(900);
    }
    expect(hitLine).toBeGreaterThanOrEqual(3);
  });

  it('forward: matches by basename and by full absolute path', () => {
    const map = parseSynctex(fixture);
    let line = 3;
    while (line <= 8 && !map.forward('main.tex', line)) line++;

    const byBase = map.forward('main.tex', line);
    const byAbs = map.forward('/tmp/synctex-fix/main.tex', line);
    const byRel = map.forward('./main.tex', line);
    expect(byBase).not.toBeNull();
    expect(byAbs).not.toBeNull();
    expect(byRel).not.toBeNull();
    expect(byAbs?.page).toBe(byBase?.page);
  });

  it('round-trip: reverse of a forward rect center lands back on main.tex', () => {
    const map = parseSynctex(fixture);
    let line = 3;
    let fwd = map.forward('main.tex', line);
    while (line <= 8 && !fwd) {
      line++;
      fwd = map.forward('main.tex', line);
    }
    expect(fwd).not.toBeNull();

    const rect = fwd!.rects[0];
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const rev = map.reverse(fwd!.page, cx, cy);

    expect(rev).not.toBeNull();
    expect(rev?.file.endsWith('main.tex')).toBe(true);
    expect(rev?.line).toBeGreaterThanOrEqual(1);
    // Reverse should resolve near the forward line (box selection may pick an
    // adjacent line for tightly stacked content).
    expect(Math.abs((rev?.line ?? 0) - line)).toBeLessThanOrEqual(2);
  });

  it('reverse: returns null on an empty page', () => {
    const map = parseSynctex(fixture);
    expect(map.reverse(999, 100, 100)).toBeNull();
  });
});

describe('parseSynctex (BusyTeX MEMFS paths)', () => {
  // Minimal synctex text mimicking BusyTeX's MEMFS-absolute Input path.
  const memfsText = [
    'SyncTeX Version:1',
    'Input:1:/home/web_user/project_dir/main.tex',
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    '[1,10:4736286,42152922:26673152,39321600,0',
    'h1,10:4736286,10000000:983040,400000,0',
    '}1',
    'Postamble:',
  ].join('\n');

  it('forward matches a host-relative query against a MEMFS-recorded path', () => {
    const map = parseSynctex(gzipSync(new TextEncoder().encode(memfsText)));
    const r = map.forward('main.tex', 10);
    expect(r).not.toBeNull();
    expect(r?.page).toBe(1);
    expect(r?.rects.length).toBeGreaterThan(0);
  });

  it('reverse returns the raw MEMFS path (host mapping is the service layer)', () => {
    const map = parseSynctex(gzipSync(new TextEncoder().encode(memfsText)));
    const r = map.reverse(1, 100, 155);
    expect(r).not.toBeNull();
    expect(r?.file).toBe('/home/web_user/project_dir/main.tex');
  });

  it('also parses uncompressed synctex bytes (no gzip magic)', () => {
    const map = parseSynctex(new TextEncoder().encode(memfsText));
    expect(map.forward('main.tex', 10)).not.toBeNull();
  });

  it('matches an absolute host query that shares only the basename (no project open)', () => {
    // WASM standalone file, no project → query stays the absolute host path;
    // the recorded MEMFS path shares only the filename. Basename is the only
    // possible tier, so tiered matching must still resolve it.
    const map = parseSynctex(gzipSync(new TextEncoder().encode(memfsText)));
    const r = map.forward('/Users/me/paper/main.tex', 10);
    expect(r).not.toBeNull();
    expect(r?.page).toBe(1);
  });
});

describe('parseSynctex (same-basename collision)', () => {
  // Two inputs sharing a basename (intro.tex) in different folders, each with a
  // box on the SAME source line 5 but on DIFFERENT pages.
  const text = [
    'Input:1:/proj/./chapters/intro.tex',
    'Input:2:/proj/./appendix/intro.tex',
    'Content:',
    '{1',
    'h1,5:4736286,10000000:983040,400000,0',
    '}1',
    '{2',
    'h2,5:4736286,10000000:983040,400000,0',
    '}2',
    'Postamble:',
  ].join('\n');

  it('directory-qualified query resolves to the correct file/page, not the collision', () => {
    const map = parseSynctex(new TextEncoder().encode(text));
    expect(map.forward('chapters/intro.tex', 5)?.page).toBe(1);
    expect(map.forward('appendix/intro.tex', 5)?.page).toBe(2);
  });

  it('mid-path "/./" segments are collapsed so suffix matching still works', () => {
    const map = parseSynctex(new TextEncoder().encode(text));
    // Full host path with the same '/./' the compiler recorded.
    expect(map.forward('/proj/chapters/intro.tex', 5)?.page).toBe(1);
  });
});
