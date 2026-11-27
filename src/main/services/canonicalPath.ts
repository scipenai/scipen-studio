/**
 * Pure-Node canonical path helpers (zero `electron` imports so the BusyTeX
 * UtilityProcess bundle can share the exact same containment logic).
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_SYMLINK_HOPS = 40;

/** Strip Win32 long/device prefixes (`\\?\`, `\\?\UNC\`) returned by readlink on junctions. */
export function stripWindowsExtendedPrefix(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (filePath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${filePath.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (filePath.startsWith('\\\\?\\')) {
    return filePath.slice('\\\\?\\'.length);
  }
  return filePath;
}

function getErrnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function joinCanonical(basePath: string, trailingSegments: string[]): string {
  const cleanBase = stripWindowsExtendedPrefix(basePath);
  return trailingSegments.length > 0 ? path.join(cleanBase, ...trailingSegments) : cleanBase;
}

/**
 * Resolve `targetPath` through all symbolic links and Windows junctions, even
 * when trailing segments or link targets do not exist on disk yet.
 * Returns `null` on symlink loops or unexpected filesystem errors (fail closed).
 */
export function resolveCanonicalPath(
  targetPath: string,
  maxSymlinkHops = DEFAULT_MAX_SYMLINK_HOPS
): string | null {
  let current = path.resolve(targetPath);
  const pendingSegments: string[] = [];
  let hops = 0;

  while (true) {
    try {
      const resolved = fs.realpathSync(current);
      return joinCanonical(resolved, pendingSegments);
    } catch (err) {
      const code = getErrnoCode(err);
      if (code === 'ELOOP') return null;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }

    // `current` (or its target if it is a dangling link) does not exist yet.
    // Check `lstatSync` so dangling symlinks/junctions are still followed.
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        hops += 1;
        if (hops > maxSymlinkHops) return null;
        const linkTarget = stripWindowsExtendedPrefix(fs.readlinkSync(current));
        current = path.resolve(path.dirname(current), linkTarget);
        continue;
      }
      // `lstatSync` succeeded for a non-link entry whose child didn't exist?
      // Fall through to peel the last component safely.
    } catch (lstatErr) {
      const lstatCode = getErrnoCode(lstatErr);
      if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
        return null;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return joinCanonical(current, pendingSegments);
    }
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Canonical containment check resolving symlinks and Windows junctions.
 * Compares case-insensitively on Windows. Returns `false` if either path fails
 * canonical resolution.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const canonicalCandidate = resolveCanonicalPath(candidate);
  const canonicalRoot = resolveCanonicalPath(root);
  if (!canonicalCandidate || !canonicalRoot) return false;

  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(canonicalCandidate);
  const base = fold(canonicalRoot);
  const basePrefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target === base || target.startsWith(basePrefix);
}

/**
 * True if `targetPath` is an existing symlink/junction, or if inspecting it
 * fails for a reason other than non-existence (fail closed).
 */
export function isSymbolicLink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch (err) {
    const code = getErrnoCode(err);
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}
