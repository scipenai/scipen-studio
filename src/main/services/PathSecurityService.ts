/**
 * @file PathSecurityService - Intelligent path security validation
 * @description Multi-layered path security with traversal prevention, sandbox enforcement, and whitelist support.
 * @security Blocks directory traversal, sensitive system paths, and unauthorized file access
 *
 * Security layers:
 * 1. Basic defense: Block path traversal attacks (..)
 * 2. Sensitive directory blocking: Prevent access to system directories
 * 3. Project sandbox: Restrict write/delete to project directory
 * 4. Whitelist exceptions: Temporarily authorize user-selected files
 */

import path from 'path';
import { createLogger } from './LoggerService';

const logger = createLogger('PathSecurityService');

// ====== Types ======

export type PathAccessMode = 'read' | 'write' | 'delete';
export type PathCheckContext = 'project' | 'user-selected' | 'system';

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
  sanitizedPath?: string;
}

export interface PathSecurityConfig {
  /** Currently active project path */
  projectPath: string | null;
  /** Enable strict mode (only allow project files) */
  strictMode?: boolean;
}

// ====== Sensitive Path Patterns ======

/** Windows sensitive system directories (blocked) */
const SENSITIVE_PATHS_WINDOWS = [
  /^[a-z]:\\windows/i,
  /^[a-z]:\\winnt/i,
  /^[a-z]:\\system32/i,
  /^[a-z]:\\syswow64/i,
  /^[a-z]:\\program files\\common files\\microsoft shared/i,
  /^[a-z]:\\programdata\\microsoft/i,
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\microsoft/i,
  /^[a-z]:\\users\\[^\\]+\\ntuser/i,
  /^[a-z]:\\boot/i,
  /^[a-z]:\\recovery/i,
  /^[a-z]:\\\$recycle\.bin/i,
  /^[a-z]:\\system volume information/i,
];

const SENSITIVE_PATHS_UNIX = [
  /^\/etc\//,
  /^\/proc\//,
  /^\/sys\//,
  /^\/dev\//,
  /^\/boot\//,
  /^\/root\//,
  /^\/var\/log\//,
  /^\/var\/run\//,
  /^\/usr\/sbin\//,
  /^\/sbin\//,
  /^\/lib\//,
  /^\/lib64\//,
];

const SENSITIVE_PATHS_MACOS = [
  /^\/System\//i,
  /^\/Library\/Keychains/i,
  /^\/private\/var/i,
  /^\/private\/etc/i,
];

/** Sensitive file patterns (blocked for all operations) */
const SENSITIVE_FILE_PATTERNS = [
  /\.ssh[/\\]/i, // SSH key directory
  /\.gnupg[/\\]/i, // GPG key directory
  /\.aws[/\\]/i, // AWS credentials
  /\.azure[/\\]/i, // Azure credentials
  /\.gcloud[/\\]/i, // GCloud credentials
  /\.kube[/\\]/i, // Kubernetes config
  /\.docker[/\\]config\.json/i, // Docker credentials
  /id_rsa/i, // SSH private key
  /id_ed25519/i, // SSH private key
  /\.pem$/i, // Certificate/key file
  /\.key$/i, // Key file
  /password/i, // Password file
  /credential/i, // Credential file
  /secret/i, // Secret file
  /\.env$/i, // Environment variables (may contain secrets)
  /\.env\.local$/i,
  /\.env\.production$/i,
];

// ====== Path Security Service ======

class PathSecurityServiceImpl {
  private static instance: PathSecurityServiceImpl;

  private currentProjectPath: string | null = null;

  /** User-authorized paths whitelist (from file dialogs) */
  private authorizedPaths: Set<string> = new Set();

  /** Authorization expiry timestamps (path -> expiry) */
  private authorizationExpiry: Map<string, number> = new Map();

  /** Whitelist TTL in milliseconds (default: 1 hour) */
  private readonly AUTHORIZATION_TTL = 60 * 60 * 1000;

  private constructor() {
    // Periodically cleanup expired authorizations
    setInterval(() => this.cleanupExpiredAuthorizations(), 60000);
  }

  public static getInstance(): PathSecurityServiceImpl {
    if (!PathSecurityServiceImpl.instance) {
      PathSecurityServiceImpl.instance = new PathSecurityServiceImpl();
    }
    return PathSecurityServiceImpl.instance;
  }

  /** Set current project path for sandbox enforcement */
  public setProjectPath(projectPath: string | null): void {
    this.currentProjectPath = projectPath ? path.normalize(projectPath) : null;
    logger.info('[PathSecurity] Project path set to:', this.currentProjectPath);
  }

  public getProjectPath(): string | null {
    return this.currentProjectPath;
  }

  /**
   * Add path to authorized whitelist (for user-selected files via dialog).
   * @sideeffect Authorization expires after AUTHORIZATION_TTL
   */
  public authorizePathTemporarily(filePath: string): void {
    const normalized = path.normalize(filePath);
    this.authorizedPaths.add(normalized);
    this.authorizationExpiry.set(normalized, Date.now() + this.AUTHORIZATION_TTL);
    logger.info('[PathSecurity] Path authorized:', normalized);
  }

  /** Batch authorize multiple paths */
  public authorizePathsTemporarily(filePaths: string[]): void {
    for (const p of filePaths) {
      this.authorizePathTemporarily(p);
    }
  }

  /** Revoke authorization for a path */
  public revokeAuthorization(filePath: string): void {
    const normalized = path.normalize(filePath);
    this.authorizedPaths.delete(normalized);
    this.authorizationExpiry.delete(normalized);
  }

  /** Clear all temporary authorizations */
  public clearAllAuthorizations(): void {
    this.authorizedPaths.clear();
    this.authorizationExpiry.clear();
    logger.info('[PathSecurity] All authorizations cleared');
  }

  /** Remove expired authorizations */
  private cleanupExpiredAuthorizations(): void {
    const now = Date.now();
    for (const [p, expiry] of this.authorizationExpiry.entries()) {
      if (now > expiry) {
        this.authorizedPaths.delete(p);
        this.authorizationExpiry.delete(p);
      }
    }
  }

  /** Check if path is in whitelist and not expired */
  private isPathAuthorized(filePath: string): boolean {
    const normalized = path.normalize(filePath);

    // Check exact match
    if (this.authorizedPaths.has(normalized)) {
      const expiry = this.authorizationExpiry.get(normalized);
      if (expiry && Date.now() <= expiry) {
        return true;
      }
      // Expired, cleanup
      this.authorizedPaths.delete(normalized);
      this.authorizationExpiry.delete(normalized);
    }

    // Check if parent directory is authorized (children inherit access)
    for (const authorizedPath of this.authorizedPaths) {
      if (normalized.startsWith(authorizedPath + path.sep)) {
        const expiry = this.authorizationExpiry.get(authorizedPath);
        if (expiry && Date.now() <= expiry) {
          return true;
        }
      }
    }

    return false;
  }

  // ====== Core Security Check ======

  /**
   * Core path security validation.
   * @param filePath - Path to validate
   * @param mode - Access mode (read/write/delete)
   * @param context - Calling context
   * @throws Never throws; returns PathCheckResult with allowed=false on failure
   */
  public checkPath(
    filePath: string,
    mode: PathAccessMode = 'read',
    context: PathCheckContext = 'project'
  ): PathCheckResult {
    // === 0. Basic Input Validation ===
    if (!filePath || filePath.trim() === '') {
      return {
        allowed: false,
        reason: 'Empty path is not allowed',
      };
    }

    // Null byte injection prevention
    if (filePath.includes('\0')) {
      return {
        allowed: false,
        reason: 'Null bytes are not allowed in file paths',
      };
    }

    // Protocol URL check (file://, data:, javascript:, etc.)
    // Note: Must exclude Windows drive paths (C:\)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(filePath) && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
      return {
        allowed: false,
        reason: 'Protocol URLs are not allowed as file paths',
      };
    }

    // === 1. Path Traversal Prevention ===
    if (this.containsPathTraversal(filePath)) {
      return {
        allowed: false,
        reason: 'Path traversal detected: ".." is not allowed in file paths',
      };
    }

    const normalizedPath = path.normalize(filePath);

    // === 2. Sensitive Directory Blocking ===
    if (this.isSensitivePath(normalizedPath)) {
      return {
        allowed: false,
        reason: `Access denied: "${normalizedPath}" is a protected system path`,
      };
    }

    // === 3. Sensitive File Check ===
    if (this.isSensitiveFile(normalizedPath)) {
      return {
        allowed: false,
        reason: `Access denied: "${path.basename(normalizedPath)}" is a sensitive/credential file`,
      };
    }

    // === 4. Whitelist Exception Check ===
    if (this.isPathAuthorized(normalizedPath)) {
      return {
        allowed: true,
        sanitizedPath: normalizedPath,
      };
    }

    // === 4.5. App Data Directory Whitelist ===
    // App's own data directory (backups, cache) allows read/write/delete
    if (this.isAppDataPath(normalizedPath)) {
      return {
        allowed: true,
        sanitizedPath: normalizedPath,
      };
    }

    // === 5. Project Sandbox Check ===
    if (context === 'project') {
      if (!this.currentProjectPath) {
        // No open project: only allow read operations
        if (mode === 'read') {
          return {
            allowed: true,
            sanitizedPath: normalizedPath,
          };
        }
        return {
          allowed: false,
          reason: 'No active project. Please open a project first.',
        };
      }

      // Check if within project directory
      if (!this.isWithinProject(normalizedPath)) {
        // Read operations allowed, but write/delete must be within project
        if (mode === 'read') {
          console.warn(`[PathSecurity] Read access to external path: ${normalizedPath}`);
          return {
            allowed: true,
            sanitizedPath: normalizedPath,
          };
        }
        return {
          allowed: false,
          reason: `Access denied: "${normalizedPath}" is outside the project directory. Only files within "${this.currentProjectPath}" can be modified.`,
        };
      }
    }

    // All checks passed
    return {
      allowed: true,
      sanitizedPath: normalizedPath,
    };
  }

  /**
   * Strict mode: enforce path must be within project directory.
   * @remarks Used for file tree, autocomplete, etc.
   */
  public checkPathStrict(filePath: string): PathCheckResult {
    const basicCheck = this.checkPath(filePath, 'read', 'project');
    if (!basicCheck.allowed) {
      return basicCheck;
    }

    if (!this.currentProjectPath) {
      return {
        allowed: false,
        reason: 'No active project',
      };
    }

    const normalizedPath = path.normalize(filePath);
    if (!this.isWithinProject(normalizedPath)) {
      return {
        allowed: false,
        reason: `Path must be within project directory: ${this.currentProjectPath}`,
      };
    }

    return {
      allowed: true,
      sanitizedPath: normalizedPath,
    };
  }

  // ====== Security Check Helpers ======

  /** Detect path traversal attack patterns */
  private containsPathTraversal(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    // Check various .. patterns
    if (
      normalized.includes('../') ||
      normalized.includes('/..') ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.endsWith('/..')
    ) {
      return true;
    }

    // Windows style
    if (filePath.includes('..\\') || filePath.includes('\\..')) {
      return true;
    }

    // URL encoded .. (%2e%2e)
    if (filePath.toLowerCase().includes('%2e%2e')) {
      return true;
    }

    return false;
  }

  /** Check if path is a sensitive system path */
  private isSensitivePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const platform = process.platform;

    if (platform === 'win32') {
      for (const pattern of SENSITIVE_PATHS_WINDOWS) {
        if (pattern.test(filePath)) {
          return true;
        }
      }
    } else if (platform === 'darwin') {
      for (const pattern of [...SENSITIVE_PATHS_UNIX, ...SENSITIVE_PATHS_MACOS]) {
        if (pattern.test(normalized)) {
          return true;
        }
      }
    } else {
      // Linux and other Unix-like systems
      for (const pattern of SENSITIVE_PATHS_UNIX) {
        if (pattern.test(normalized)) {
          return true;
        }
      }
    }

    return false;
  }

  /** Check if path matches sensitive file patterns */
  private isSensitiveFile(filePath: string): boolean {
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return true;
      }
    }
    return false;
  }

  /** Check if path is within app data directory (backup, cache, etc.) */
  private isAppDataPath(filePath: string): boolean {
    try {
      const { app } = require('electron');
      const appDataDir = app.getPath('userData');

      const normalizedFilePath = path.normalize(filePath);
      const normalizedAppDataDir = path.normalize(appDataDir);

      return (
        normalizedFilePath === normalizedAppDataDir ||
        normalizedFilePath.startsWith(normalizedAppDataDir + path.sep)
      );
    } catch {
      // app may not be accessible outside main process
      return false;
    }
  }

  /** Check if path is within current project directory */
  private isWithinProject(filePath: string): boolean {
    if (!this.currentProjectPath) {
      return false;
    }

    const normalizedFilePath = path.normalize(filePath);
    const normalizedProjectPath = path.normalize(this.currentProjectPath);

    return (
      normalizedFilePath === normalizedProjectPath ||
      normalizedFilePath.startsWith(normalizedProjectPath + path.sep)
    );
  }

  /** Get security stats for debugging */
  public getStats(): {
    projectPath: string | null;
    authorizedPathsCount: number;
    authorizedPaths: string[];
  } {
    return {
      projectPath: this.currentProjectPath,
      authorizedPathsCount: this.authorizedPaths.size,
      authorizedPaths: Array.from(this.authorizedPaths),
    };
  }
}

// ====== Exports ======

export const PathSecurityService = PathSecurityServiceImpl.getInstance();

/** Convenience function for path security check */
export function checkPathSecurity(
  filePath: string,
  mode: PathAccessMode = 'read',
  context: PathCheckContext = 'project'
): PathCheckResult {
  return PathSecurityService.checkPath(filePath, mode, context);
}

export function setProjectPath(projectPath: string | null): void {
  PathSecurityService.setProjectPath(projectPath);
}

export function authorizePathTemporarily(filePath: string): void {
  PathSecurityService.authorizePathTemporarily(filePath);
}
