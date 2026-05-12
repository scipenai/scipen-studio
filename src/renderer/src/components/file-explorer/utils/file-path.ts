/**
 * @file file-path.ts - Path utility functions for FileExplorer
 * @description Helpers for parent path resolution.
 */

// ====== Path Utilities ======

/** Return the parent directory of a path. */
export const getParentPath = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/') || path;
};
