import { afterEach, describe, expect, it } from 'vitest';

import {
  getRelativePathFromRoot,
  isSameOrChildPath,
  isSamePath,
  normalizeComparablePath,
} from '../../../src/renderer/src/utils/pathComparison';

function setPlatform(platform: string | undefined): void {
  const w = globalThis as unknown as { window?: { electron?: { platform?: string } } };
  if (!w.window) w.window = {};
  w.window.electron = platform ? { platform } : undefined;
}

describe('pathComparison', () => {
  afterEach(() => {
    setPlatform(undefined);
  });

  it('normalizes windows and posix separators before comparing', () => {
    expect(isSamePath('C:\\Users\\demo\\project', 'C:/Users/demo/project')).toBe(true);
    expect(normalizeComparablePath('C:\\Users\\demo\\project\\')).toBe('C:/Users/demo/project');
  });

  it('distinguishes sibling directories when checking child paths', () => {
    expect(isSameOrChildPath('C:\\work\\demo\\src\\main.tex', 'C:/work/demo')).toBe(true);
    expect(isSameOrChildPath('C:\\work\\demo-2\\src\\main.tex', 'C:/work/demo')).toBe(false);
  });

  it('returns normalized relative path for same file tree root', () => {
    expect(getRelativePathFromRoot('C:\\work\\demo\\src\\main.tex', 'C:/work/demo')).toBe(
      'src/main.tex'
    );
    expect(getRelativePathFromRoot('C:\\work\\demo', 'C:/work/demo')).toBe('');
  });

  it('stays case-sensitive on non-Windows platforms', () => {
    setPlatform('linux');
    expect(isSamePath('/work/Demo', '/work/demo')).toBe(false);
    expect(isSameOrChildPath('/work/Demo/src/main.tex', '/work/demo')).toBe(false);
    expect(getRelativePathFromRoot('/work/Demo/src/main.tex', '/work/demo')).toBe(null);
  });

  it('folds case when comparing on Windows', () => {
    setPlatform('win32');
    // Drive-letter / prefix casing drift from the native watcher must still match.
    expect(isSamePath('c:\\work\\demo', 'C:/work/demo')).toBe(true);
    expect(isSameOrChildPath('c:\\work\\demo\\src\\main.tex', 'C:/work/demo')).toBe(true);
  });

  it('preserves real casing in the returned relative path on Windows', () => {
    setPlatform('win32');
    // Root casing differs, but the file-name portion keeps its actual casing.
    expect(getRelativePathFromRoot('c:\\work\\demo\\src\\Main.TeX', 'C:/work/demo')).toBe(
      'src/Main.TeX'
    );
  });
});
