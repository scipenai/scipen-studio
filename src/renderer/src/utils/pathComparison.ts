/**
 * @file pathComparison.ts - Renderer-side path comparison helpers
 * @description Normalizes slash style for path equality / containment checks.
 *   On Windows the filesystem is case-insensitive, so comparisons case-fold
 *   both sides; the actual casing of returned paths is always preserved.
 */

/**
 * Whether the renderer is running on Windows. Read at call time (not module
 * load) so tests can toggle `window.electron.platform`. Off Windows this is
 * `false` and every helper below keeps its original case-sensitive behavior.
 */
function isWindowsRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { electron?: { platform?: string } };
  return w.electron?.platform === 'win32';
}

/** Case-fold a path for comparison only (no-op except on Windows). */
function toCaseFolded(path: string): string {
  return isWindowsRuntime() ? path.toLowerCase() : path;
}

export function normalizeComparablePath(path?: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function isSamePath(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return (
    !!normalizedLeft &&
    !!normalizedRight &&
    toCaseFolded(normalizedLeft) === toCaseFolded(normalizedRight)
  );
}

export function isSameOrChildPath(path?: string | null, rootPath?: string | null): boolean {
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (!normalizedPath || !normalizedRoot) return false;
  const foldedPath = toCaseFolded(normalizedPath);
  const foldedRoot = toCaseFolded(normalizedRoot);
  return foldedPath === foldedRoot || foldedPath.startsWith(`${foldedRoot}/`);
}

export function getRelativePathFromRoot(
  path?: string | null,
  rootPath?: string | null
): string | null {
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (!normalizedPath || !normalizedRoot) return null;
  const foldedPath = toCaseFolded(normalizedPath);
  const foldedRoot = toCaseFolded(normalizedRoot);
  if (foldedPath === foldedRoot) return '';
  if (!foldedPath.startsWith(`${foldedRoot}/`)) return null;
  // Slice the case-preserving path so the returned relative path keeps real casing.
  return normalizedPath.slice(normalizedRoot.length + 1);
}
