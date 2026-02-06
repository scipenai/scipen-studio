/**
 * @file fileValidation.ts - Filename validation utility
 * @description Validates filenames for cross-platform compatibility. Ported from VS Code's
 *              filename validation logic to ensure safe file operations on Windows/macOS/Linux.
 * @depends utils/index (getPlatform)
 */

import { getPlatform } from './index';

// ====== Types ======

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

// ====== Constants ======

// Windows reserved names - cannot be used as file/folder names
const WINDOWS_RESERVED_NAMES = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

const WINDOWS_INVALID_CHARS = /[\\/:*?"<>|]/;
const UNIVERSAL_INVALID_CHARS = /[/\\]/;

// ====== Utility Functions ======

/**
 * Trims whitespace from filename.
 */
export function trimFileName(name: string): string {
  return name.trim();
}

/**
 * Returns a well-formed filename with platform-specific normalization.
 * Why trailing dot removal: Windows silently strips trailing dots, causing unexpected behavior.
 */
export function getWellFormedFileName(name: string): string {
  let result = trimFileName(name);

  if (getPlatform() === 'windows') {
    result = result.replace(/\.+$/, '');
  }

  return result;
}

// ====== Validation Functions ======

/**
 * Validates a filename for the current platform.
 *
 * @throws Never - returns ValidationResult instead
 */
export function validateFileName(
  name: string,
  existingNames: string[] = [],
  currentName?: string
): ValidationResult {
  const wellFormedName = getWellFormedFileName(name);

  if (!wellFormedName || wellFormedName.length === 0 || /^\s+$/.test(wellFormedName)) {
    return {
      valid: false,
      error: 'File or folder name cannot be empty',
    };
  }

  if (wellFormedName[0] === '/' || wellFormedName[0] === '\\') {
    return {
      valid: false,
      error: 'File or folder name cannot start with a slash',
    };
  }

  if (UNIVERSAL_INVALID_CHARS.test(wellFormedName)) {
    return {
      valid: false,
      error: 'File name cannot contain / or \\ characters',
    };
  }

  if (getPlatform() === 'windows' && WINDOWS_INVALID_CHARS.test(wellFormedName)) {
    return {
      valid: false,
      error: 'File name cannot contain these characters: \\ / : * ? " < > |',
    };
  }

  if (getPlatform() === 'windows') {
    const nameWithoutExt = wellFormedName.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.includes(nameWithoutExt)) {
      return {
        valid: false,
        error: `"${nameWithoutExt}" is a Windows reserved name`,
      };
    }
  }

  // Why 255: Most file systems (NTFS, ext4, HFS+) limit filenames to 255 chars
  if (wellFormedName.length > 255) {
    return {
      valid: false,
      error: 'File name too long (max 255 characters)',
    };
  }

  // Check for duplicates (case-insensitive on Windows/macOS)
  const lowerName = wellFormedName.toLowerCase();
  const lowerCurrentName = currentName?.toLowerCase();

  for (const existing of existingNames) {
    const lowerExisting = existing.toLowerCase();
    if (lowerCurrentName && lowerExisting === lowerCurrentName) {
      continue;
    }
    // Why case-insensitive: Windows and macOS filesystems are case-insensitive
    if (getPlatform() !== 'linux' && lowerExisting === lowerName) {
      return {
        valid: false,
        error: `"${existing}" already exists`,
      };
    }
    if (getPlatform() === 'linux' && existing === wellFormedName) {
      return {
        valid: false,
        error: `"${existing}" already exists`,
      };
    }
  }

  if (/^\s|\s$/.test(name)) {
    return {
      valid: true,
      warning: 'File name has leading/trailing spaces which may cause issues',
    };
  }

  if (wellFormedName.startsWith('.') && wellFormedName !== '.') {
    return {
      valid: true,
      warning: 'Files starting with dot are hidden on some systems',
    };
  }

  return { valid: true };
}

/**
 * Validates a complete file path (including directories).
 */
export function validateFilePath(path: string): ValidationResult {
  if (!path || path.trim().length === 0) {
    return {
      valid: false,
      error: 'Path cannot be empty',
    };
  }

  const parts = path.split(/[/\\]/).filter((p) => p.length > 0);

  for (const part of parts) {
    // Skip Windows drive letter (e.g., "C:")
    if (getPlatform() === 'windows' && /^[a-zA-Z]:$/.test(part)) {
      continue;
    }

    const result = validateFileName(part);
    if (!result.valid) {
      return {
        valid: false,
        error: `Invalid path segment "${part}": ${result.error}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Quick check if filename is valid (without duplicate checking).
 * Use for real-time input validation.
 */
export function isValidFileName(name: string): boolean {
  return validateFileName(name).valid;
}
