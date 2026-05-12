/**
 * @file pathComparison.ts - Renderer-side path comparison helpers
 * @description Normalizes slash style for path equality / containment checks.
 */

export function normalizeComparablePath(path?: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function isSamePath(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

export function isSameOrChildPath(path?: string | null, rootPath?: string | null): boolean {
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function getRelativePathFromRoot(
  path?: string | null,
  rootPath?: string | null
): string | null {
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (!normalizedPath || !normalizedRoot) return null;
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}
