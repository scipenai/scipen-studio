/**
 * @file Shared helpers, types, and utilities for file IPC handlers
 * @description Extracted from fileHandlers.ts to support module splitting.
 * @security Path validation utilities.
 */

import path from 'path';
import type { BrowserWindow } from 'electron';
import {
  type PathAccessMode,
  PathSecurityService,
  checkPathSecurity,
} from '../services/PathSecurityService';
import { ServiceNames, getServiceContainer } from '../services/ServiceContainer';
import type { ProjectBindingService } from '../services/ProjectBindingService';
import type { IFileSystemService } from '../services/interfaces';
import { createLogger } from '../services/LoggerService';

// ============ Logger ============

export const logger = createLogger('FileHandlers');

// ============ Project Root Resolution ============

const DERIVED_PROJECT_DIRS = new Set(['output', 'out', 'dist', 'build', 'target']);

function getBindingService(): ProjectBindingService {
  return getServiceContainer().get<ProjectBindingService>(ServiceNames.PROJECT_BINDING);
}

function shouldReuseResolvedProjectRoot(requestedPath: string, bindingRootPath: string): boolean {
  const normalizedRequested = path.normalize(requestedPath);
  const normalizedRoot = path.normalize(bindingRootPath);
  if (normalizedRequested === normalizedRoot) {
    return true;
  }
  if (!normalizedRequested.startsWith(`${normalizedRoot}${path.sep}`)) {
    return false;
  }

  const relative = path.relative(normalizedRoot, normalizedRequested);
  const segments = relative.split(path.sep).filter(Boolean);
  return (
    segments.length > 0 &&
    segments.every((segment) => DERIVED_PROJECT_DIRS.has(segment.toLowerCase()))
  );
}

export async function resolveProjectOpenRoot(projectPath: string): Promise<string> {
  try {
    const resolved = await getBindingService().resolveBinding(projectPath);
    if (
      resolved.found &&
      resolved.binding?.localRootPath &&
      shouldReuseResolvedProjectRoot(projectPath, resolved.binding.localRootPath)
    ) {
      return resolved.binding.localRootPath;
    }
    if (resolved.found && resolved.binding?.localRootPath) {
      logger.info(
        `Ignoring ancestor binding and opening project from requested path: ${projectPath} (binding=${resolved.binding.localRootPath})`
      );
    }
  } catch (error) {
    logger.warn('Failed to resolve project open root, falling back to the requested path:', error);
  }
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
