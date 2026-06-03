/**
 * @file Shared helpers, types, and utilities for file IPC handlers
 * @description Extracted from fileHandlers.ts to support module splitting.
 * @security Path validation utilities.
 */

import type { BrowserWindow } from 'electron';
import {
  type PathAccessMode,
  PathSecurityService,
  checkPathSecurity,
} from '../services/PathSecurityService';
import type { IFileSystemService } from '../services/interfaces';
import { createLogger } from '../services/LoggerService';

// ============ Logger ============

export const logger = createLogger('FileHandlers');

// ============ Project Root Resolution ============

/**
 * After the IM/OT cleanup, project bindings are gone — we no longer
 * resolve ancestor project roots through the binding service. Callers
 * just open the path they requested.
 */
export async function resolveProjectOpenRoot(projectPath: string): Promise<string> {
  return projectPath;
}

// ============ Path Helpers ============

/** @security Validate path security, throws if unsafe */
export function assertPathSecurity(
  filePath: string,
  mode: PathAccessMode = 'read',
  options?: { allowOutsideProject?: boolean }
): string {
  const context = options?.allowOutsideProject ? 'user-selected' : 'project';
  const result = checkPathSecurity(filePath, mode, context);

  if (!result.allowed) {
    console.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(result.reason || 'Access denied');
  }

  return result.sanitizedPath || filePath;
}

// ============ Types ============

/**
 * Dependencies required for IPC handler registration.
 * @remarks Callers should provide live services; handlers are long-lived.
 */
export interface FileHandlersDeps {
  fileSystemService: IFileSystemService;
  getMainWindow: () => BrowserWindow | null;
  getWindows: () => Map<number, BrowserWindow>;
  addRecentProject: (projectPath: string, isRemote?: boolean) => Promise<void>;
  loadRecentProjects: () => Promise<
    Array<{
      id: string;
      name: string;
      path: string;
      lastOpened: string;
      isRemote?: boolean;
    }>
  >;
}

// Re-export PathSecurityService for sub-modules that need setProjectPath
export { PathSecurityService };
