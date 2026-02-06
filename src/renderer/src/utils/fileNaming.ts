/**
 * @file fileNaming.ts - Smart file naming utility
 * @description Ported from VS Code's incremental naming algorithm to resolve filename conflicts during copy/paste operations
 * @depends None (pure utility functions)
 */

// ====== Types ======

/**
 * Incremental naming pattern
 * - simple: test.txt → test copy.txt → test copy 2.txt
 * - smart: test.txt → test.1.txt → test.2.txt
 */
export type IncrementalNamingMode = 'simple' | 'smart';

// ====== Helper Functions ======

function splitFileName(name: string, isFolder: boolean): { baseName: string; extension: string } {
  if (isFolder) {
    return { baseName: name, extension: '' };
  }

  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) {
    // No extension or starts with dot (e.g., .gitignore)
    return { baseName: name, extension: '' };
  }

  return {
    baseName: name.slice(0, lastDot),
    extension: name.slice(lastDot),
  };
}

/**
 * Simple mode: test.txt → test copy.txt → test copy 2.txt
 */
function incrementFileNameSimple(name: string, isFolder: boolean): string {
  const { baseName, extension } = splitFileName(name, isFolder);

  // Match "xxx copy" or "xxx copy N" pattern
  const copyRegex = /^(.+) copy( \d+)?$/;
  const match = baseName.match(copyRegex);

  if (match) {
    const prefix = match[1];
    const numberPart = match[2];

    if (numberPart) {
      const num = Number.parseInt(numberPart.trim(), 10);
      if (num < Number.MAX_SAFE_INTEGER) {
        return `${prefix} copy ${num + 1}${extension}`;
      }
      return `${prefix}${numberPart} copy${extension}`;
    }

    return `${prefix} copy 2${extension}`;
  }

  return `${baseName} copy${extension}`;
}

/**
 * Smart mode: test.txt → test.1.txt, file1.txt → file2.txt
 */
function incrementFileNameSmart(name: string, isFolder: boolean): string {
  const { baseName, extension } = splitFileName(name, isFolder);
  const maxNumber = Number.MAX_SAFE_INTEGER;

  const separators = '[\\.\\-_]';

  // Pattern 1: file.1.txt or file-1.txt → file.2.txt
  if (!isFolder) {
    const suffixRegex = new RegExp(`(.*${separators})(\\d+)$`);
    const suffixMatch = baseName.match(suffixRegex);

    if (suffixMatch) {
      const prefix = suffixMatch[1];
      const numStr = suffixMatch[2];
      const num = Number.parseInt(numStr, 10);

      if (num < maxNumber) {
        // Preserve leading zeros
        const newNum = String(num + 1).padStart(numStr.length, '0');
        return `${prefix}${newNum}${extension}`;
      }
      return `${baseName}.1${extension}`;
    }
  }

  // Pattern 2: 1.test.txt → 2.test.txt
  if (!isFolder) {
    const prefixRegex = new RegExp(`^(\\d+)(${separators}.*)$`);
    const prefixMatch = baseName.match(prefixRegex);

    if (prefixMatch) {
      const numStr = prefixMatch[1];
      const suffix = prefixMatch[2];
      const num = Number.parseInt(numStr, 10);

      if (num < maxNumber) {
        const newNum = String(num + 1).padStart(numStr.length, '0');
        return `${newNum}${suffix}${extension}`;
      }
      return `${baseName}.1${extension}`;
    }
  }

  // Pattern 3: file1.txt → file2.txt (trailing number)
  const endNumRegex = /^(.*?)(\d+)$/;
  const endNumMatch = baseName.match(endNumRegex);

  if (endNumMatch) {
    const prefix = endNumMatch[1];
    const numStr = endNumMatch[2];
    const num = Number.parseInt(numStr, 10);

    if (num < maxNumber) {
      return `${prefix}${num + 1}${extension}`;
    }
    return `${baseName}.1${extension}`;
  }

  // Pattern 4: pure numeric filename 001 → 002
  if (/^\d+$/.test(baseName)) {
    const num = Number.parseInt(baseName, 10);
    if (num < maxNumber) {
      const newNum = String(num + 1).padStart(baseName.length, '0');
      return `${newNum}${extension}`;
    }
    return `${baseName}.1${extension}`;
  }

  // Default: append .1 before extension or 1 at end
  if (extension) {
    return `${baseName}.1${extension}`;
  }
  return `${baseName}1`;
}

// ====== Public API ======

/**
 * Generates an incremented filename for conflict resolution.
 */
export function incrementFileName(
  name: string,
  isFolder: boolean,
  mode: IncrementalNamingMode = 'simple'
): string {
  if (mode === 'smart') {
    return incrementFileNameSmart(name, isFolder);
  }
  return incrementFileNameSimple(name, isFolder);
}

/**
 * Finds a non-conflicting filename given existing names.
 */
export function findAvailableFileName(
  desiredName: string,
  existingNames: string[],
  isFolder: boolean,
  mode: IncrementalNamingMode = 'simple'
): string {
  // Case-insensitive comparison (Windows/macOS behavior)
  const existingSet = new Set(existingNames.map((n) => n.toLowerCase()));

  let candidateName = desiredName;
  let iterations = 0;
  const maxIterations = 1000;

  while (existingSet.has(candidateName.toLowerCase()) && iterations < maxIterations) {
    candidateName = incrementFileName(candidateName, isFolder, mode);
    iterations++;
  }

  if (iterations >= maxIterations) {
    // Fallback: timestamp-based name for extreme cases
    const { baseName, extension } = splitFileName(desiredName, isFolder);
    const timestamp = Date.now();
    return `${baseName}-${timestamp}${extension}`;
  }

  return candidateName;
}

/**
 * Batch finds non-conflicting filenames for multiple files (e.g., paste operation).
 */
export function findAvailableFileNames(
  desiredNames: string[],
  existingNames: string[],
  isFolders: boolean[],
  mode: IncrementalNamingMode = 'simple'
): string[] {
  const allExisting = [...existingNames];
  const results: string[] = [];

  for (let i = 0; i < desiredNames.length; i++) {
    const desired = desiredNames[i];
    const isFolder = isFolders[i] ?? false;

    const available = findAvailableFileName(desired, allExisting, isFolder, mode);
    results.push(available);

    // Add new name to prevent subsequent files from conflicting
    allExisting.push(available);
  }

  return results;
}
