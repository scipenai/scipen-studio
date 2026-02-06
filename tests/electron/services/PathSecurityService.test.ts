/**
 * @file PathSecurityService.test.ts - Unit tests for path security service
 * @description Tests boundary behavior: in-project access, out-of-project access, user-selected paths (temporary authorization), sensitive directory blocking, and path traversal attack defense
 * @depends PathSecurityService
 */

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PathSecurityService,
  checkPathSecurity,
  setProjectPath,
} from '../../../src/main/services/PathSecurityService';

// ====== Helper Functions ======

/**
 * Simulate assertPathSecurity behavior (for testing)
 */
function assertPathSecurity(filePath: string, mode: 'read' | 'write' | 'delete' = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'project');
  if (!result.allowed) {
    throw new Error(result.reason || 'Access denied');
  }
  return result.sanitizedPath || filePath;
}

// ====== Test Constants ======

const TEST_PROJECT_PATH =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\projects\\my-latex'
    : '/home/test/projects/my-latex';

const TEST_PROJECT_FILE =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\projects\\my-latex\\main.tex'
    : '/home/test/projects/my-latex/main.tex';

const TEST_EXTERNAL_FILE =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\documents\\external.pdf'
    : '/home/test/documents/external.pdf';

const SENSITIVE_PATH_WINDOWS = 'C:\\Windows\\System32\\config';
const SENSITIVE_PATH_UNIX = '/etc/passwd';

// ====== Test Suites ======

describe('PathSecurityService', () => {
  beforeEach(() => {
    PathSecurityService.setProjectPath(null);
    PathSecurityService.clearAllAuthorizations();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Path Traversal Defense', () => {
    it('should block path traversal attacks with ../', () => {
      const result = PathSecurityService.checkPath('../../../etc/passwd', 'read', 'project');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('traversal');
    });

    it('should block path traversal attacks with ..\\', () => {
      const result = PathSecurityService.checkPath('..\\..\\Windows\\System32', 'read', 'project');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('traversal');
    });

    it('should block null bytes in path', () => {
      const result = PathSecurityService.checkPath('/safe/path\0/evil', 'read', 'project');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Sensitive Directory Protection', () => {
    it('should block access to Windows system directories', () => {
      if (process.platform !== 'win32') {
        return; // Skip on non-Windows
      }

      const sensitivePaths = [
        'C:\\Windows\\System32',
        'C:\\Windows\\SysWOW64',
        'C:\\Program Files\\Common Files\\Microsoft Shared',
      ];

      for (const p of sensitivePaths) {
        const result = PathSecurityService.checkPath(p, 'read', 'user-selected');
        expect(result.allowed, `Should block: ${p}`).toBe(false);
        expect(result.reason).toContain('protected');
      }
    });

    it('should block access to Unix system directories', () => {
      if (process.platform === 'win32') {
        return; // Skip on Windows
      }

      const sensitivePaths = ['/etc/shadow', '/proc/self', '/sys/kernel', '/dev/sda'];

      for (const p of sensitivePaths) {
        const result = PathSecurityService.checkPath(p, 'read', 'user-selected');
        expect(result.allowed, `Should block: ${p}`).toBe(false);
      }
    });

    it('should block access to SSH keys directory', () => {
      const sshPath =
        process.platform === 'win32' ? 'C:\\Users\\test\\.ssh\\id_rsa' : '/home/test/.ssh/id_rsa';

      const result = PathSecurityService.checkPath(sshPath, 'read', 'user-selected');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Project Scope Enforcement', () => {
    beforeEach(() => {
      PathSecurityService.setProjectPath(TEST_PROJECT_PATH);
    });

    it('should allow read access to files within project', () => {
      const result = PathSecurityService.checkPath(TEST_PROJECT_FILE, 'read', 'project');
      expect(result.allowed).toBe(true);
      expect(result.sanitizedPath).toBeDefined();
    });

    it('should allow write access to files within project', () => {
      const result = PathSecurityService.checkPath(TEST_PROJECT_FILE, 'write', 'project');
      expect(result.allowed).toBe(true);
    });

    it('should allow read access to files outside project (with warning)', () => {
      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'read', 'project');
      expect(result.allowed).toBe(true);
    });

    it('should block write access to files outside project', () => {
      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'write', 'project');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });

    it('should block delete access to files outside project', () => {
      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'delete', 'project');
      expect(result.allowed).toBe(false);
    });
  });

  describe('User-Selected Path Authorization', () => {
    beforeEach(() => {
      PathSecurityService.setProjectPath(TEST_PROJECT_PATH);
    });

    it('should allow access to user-selected external paths', () => {
      PathSecurityService.authorizePathTemporarily(TEST_EXTERNAL_FILE);

      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'read', 'user-selected');
      expect(result.allowed).toBe(true);
    });

    it('should allow write to authorized external paths', () => {
      PathSecurityService.authorizePathTemporarily(TEST_EXTERNAL_FILE);

      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'write', 'user-selected');
      expect(result.allowed).toBe(true);
    });

    it('should not allow access to non-authorized external paths in strict mode', () => {
      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'write', 'project');
      expect(result.allowed).toBe(false);
    });

    it('should clear authorized paths correctly', () => {
      PathSecurityService.authorizePathTemporarily(TEST_EXTERNAL_FILE);
      PathSecurityService.clearAllAuthorizations();

      const result = PathSecurityService.checkPath(TEST_EXTERNAL_FILE, 'write', 'project');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Path Normalization', () => {
    beforeEach(() => {
      PathSecurityService.setProjectPath(TEST_PROJECT_PATH);
    });

    it('should normalize paths with mixed separators', () => {
      if (process.platform !== 'win32') {
        return;
      }

      const mixedPath = 'C:\\Users\\test\\projects/my-latex\\main.tex';
      const result = PathSecurityService.checkPath(mixedPath, 'read', 'project');
      expect(result.allowed).toBe(true);
      expect(result.sanitizedPath).toBeDefined();
    });

    it('should handle paths with redundant slashes', () => {
      const redundantPath =
        process.platform === 'win32'
          ? 'C:\\Users\\test\\\\projects\\my-latex\\\\main.tex'
          : '/home/test//projects/my-latex//main.tex';

      const result = PathSecurityService.checkPath(redundantPath, 'read', 'project');
      expect(result.allowed).toBe(true);
    });

    it('should handle paths with ./current directory references', () => {
      const currentDirPath =
        process.platform === 'win32'
          ? 'C:\\Users\\test\\projects\\my-latex\\.\\main.tex'
          : '/home/test/projects/my-latex/./main.tex';

      const result = PathSecurityService.checkPath(currentDirPath, 'read', 'project');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty path', () => {
      const result = PathSecurityService.checkPath('', 'read', 'project');
      expect(result.allowed).toBe(false);
    });

    it('should handle very long paths', () => {
      const longPath = `${'a'.repeat(300)}${path.sep}file.tex`;
      const result = PathSecurityService.checkPath(longPath, 'read', 'user-selected');
      expect(result.sanitizedPath || result.reason).toBeDefined();
    });

    it('should handle unicode paths', () => {
      const unicodePath =
        process.platform === 'win32'
          ? 'C:\\Users\\test\\projects\\论文\\main.tex'
          : '/home/test/projects/论文/main.tex';

      PathSecurityService.setProjectPath(
        process.platform === 'win32'
          ? 'C:\\Users\\test\\projects\\论文'
          : '/home/test/projects/论文'
      );

      const result = PathSecurityService.checkPath(unicodePath, 'read', 'project');
      expect(result.allowed).toBe(true);
    });

    it('should handle paths with spaces', () => {
      const spacePath =
        process.platform === 'win32'
          ? 'C:\\Users\\test\\My Projects\\LaTeX Paper\\main.tex'
          : '/home/test/My Projects/LaTeX Paper/main.tex';

      PathSecurityService.setProjectPath(
        process.platform === 'win32'
          ? 'C:\\Users\\test\\My Projects\\LaTeX Paper'
          : '/home/test/My Projects/LaTeX Paper'
      );

      const result = PathSecurityService.checkPath(spacePath, 'read', 'project');
      expect(result.allowed).toBe(true);
    });
  });
});

// ====== Convenience Function Tests ======

describe('checkPathSecurity convenience function', () => {
  beforeEach(() => {
    setProjectPath(TEST_PROJECT_PATH);
  });

  it('should work like PathSecurityService.checkPath', () => {
    const result = checkPathSecurity(TEST_PROJECT_FILE, 'read', 'project');
    expect(result.allowed).toBe(true);
  });

  it('should block dangerous paths', () => {
    const result = checkPathSecurity('../../../etc/passwd', 'read', 'project');
    expect(result.allowed).toBe(false);
  });
});

describe('assertPathSecurity helper function', () => {
  beforeEach(() => {
    setProjectPath(TEST_PROJECT_PATH);
  });

  it('should return sanitized path for allowed paths', () => {
    const result = assertPathSecurity(TEST_PROJECT_FILE, 'read');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should throw for blocked paths', () => {
    expect(() => {
      assertPathSecurity('../../../etc/passwd', 'read');
    }).toThrow();
  });

  it('should throw for sensitive paths', () => {
    const sensitivePath =
      process.platform === 'win32' ? SENSITIVE_PATH_WINDOWS : SENSITIVE_PATH_UNIX;

    expect(() => {
      assertPathSecurity(sensitivePath, 'read');
    }).toThrow();
  });
});

// ====== Regression Tests ======

describe('PathSecurity - Regression Tests', () => {
  beforeEach(() => {
    setProjectPath(TEST_PROJECT_PATH);
  });

  it('should not allow arbitrary protocol handlers', () => {
    const result = checkPathSecurity('file:///etc/passwd', 'read', 'project');
    expect(result.allowed).toBe(false);
  });

  it('should handle case sensitivity correctly on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }

    const upperPath = 'C:\\USERS\\TEST\\PROJECTS\\MY-LATEX\\MAIN.TEX';
    const result = checkPathSecurity(upperPath, 'read', 'project');
    expect(result.allowed).toBe(true);
  });
});
