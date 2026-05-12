import { describe, expect, it } from 'vitest';

import {
  getRelativePathFromRoot,
  isSameOrChildPath,
  isSamePath,
  normalizeComparablePath,
} from '../../../src/renderer/src/utils/pathComparison';

describe('pathComparison', () => {
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
});
