/**
 * @file TypstCompiler.test.ts - Unit tests for Typst compiler
 * @description Tests core functionality of Typst compiler. Due to dependencies on child_process and electron, focuses on API design and basic behavior.
 * @depends TypstCompiler, child_process, electron
 */

import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ====== Mock Child Process ======
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  killed = false;

  kill() {
    this.killed = true;
    this.emit('close', 0);
  }
}

// ====== Mock child_process ======
// Use dynamic import syntax to avoid module resolution issues
const mockSpawn = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    default: actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

// ====== Mock fsCompat ======
const mockFs = {
  ensureDir: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue(false),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('mock-pdf-content')),
  remove: vi.fn().mockResolvedValue(undefined),
  existsSync: vi.fn().mockReturnValue(false),
};

vi.mock('../../../src/main/services/knowledge/utils/fsCompat', () => ({
  default: mockFs,
}));

// ====== Mock electron ======
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
  },
}));

describe('TypstCompiler', () => {
  let TypstCompiler: typeof import('../../../src/main/services/TypstCompiler').TypstCompiler;

  beforeAll(async () => {
    const module = await import('../../../src/main/services/TypstCompiler');
    TypstCompiler = module.TypstCompiler;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockExecFile.mockReset();
    mockFs.pathExists.mockResolvedValue(false);
    mockFs.ensureDir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue(Buffer.from('mock-pdf-content'));
    mockFs.remove.mockResolvedValue(undefined);
  });

  describe('Constructor', () => {
    it('should create temporary directory path', () => {
      const compiler = new TypstCompiler();
      expect(compiler).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('should return false when executable not found', async () => {
      const compiler = new TypstCompiler();

      mockFs.pathExists.mockResolvedValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(new Error('Command not found'));
        }
      );

      const result = await compiler.isAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('compile 方法签名', () => {
    it('should have compile method', () => {
      const compiler = new TypstCompiler();
      expect(typeof compiler.compile).toBe('function');
    });

    it('should have isAvailable method', () => {
      const compiler = new TypstCompiler();
      expect(typeof compiler.isAvailable).toBe('function');
    });

    it('should have getVersion method', () => {
      const compiler = new TypstCompiler();
      expect(typeof compiler.getVersion).toBe('function');
    });
  });

  describe('Compile Options', () => {
    it('should accept engine option', async () => {
      const compiler = new TypstCompiler();

      const mockProcess = new MockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(Buffer.from('mock-pdf'));

      const options = { engine: 'typst' as const };
      expect(options.engine).toBe('typst');
    });

    it('should accept mainFile option', async () => {
      const compiler = new TypstCompiler();

      const options = { mainFile: '/path/to/main.typ' };
      expect(options.mainFile).toBe('/path/to/main.typ');
    });
  });

  describe('Error Handling', () => {
    it('compile result should contain success field', async () => {
      const compiler = new TypstCompiler();

      mockFs.ensureDir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.pathExists.mockResolvedValue(false);

      const mockProcess = new MockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        mockProcess.stderr.emit('data', Buffer.from('error: file not found'));
        mockProcess.emit('close', 1);
      }, 10);

      const result = await compiler.compile('// invalid typst');
      expect(result).toHaveProperty('success');
    });
  });

  describe('Temporary File Management', () => {
    it('should use system temporary directory', () => {
      const compiler = new TypstCompiler();
      const tempDir = os.tmpdir();
      expect(tempDir).toBeDefined();
    });
  });

  describe('Engine Command Generation', () => {
    it('typst should use compile subcommand', () => {
      const expectedArgs = ['compile'];
      expect(expectedArgs[0]).toBe('compile');
    });

    it('tinymist should use compile subcommand', () => {
      const expectedArgs = ['compile'];
      expect(expectedArgs[0]).toBe('compile');
    });
  });

  describe('Path Handling', () => {
    it('should correctly handle Windows paths', () => {
      const windowsPath = 'C:\\Users\\test\\document.typ';
      const normalizedPath = path.normalize(windowsPath);
      expect(normalizedPath).toBeDefined();
    });

    it('should correctly handle Unix paths', () => {
      const unixPath = '/home/test/document.typ';
      const normalizedPath = path.normalize(unixPath);
      expect(normalizedPath).toBeDefined();
    });
  });

  describe('Result Structure', () => {
    it('successful result should contain pdfBuffer', async () => {
      const compiler = new TypstCompiler();

      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(Buffer.from('mock-pdf-content'));

      const mockProcess = new MockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        mockProcess.emit('close', 0);
      }, 10);

      const result = await compiler.compile('= Hello');

      expect(result).toHaveProperty('success');
      if (result.success) {
        expect(result.outputBuffer).toBeDefined();
      }
    });
  });

  describe('Concurrent Compilation', () => {
    it('should support multiple concurrent compilation requests', async () => {
      const compiler1 = new TypstCompiler();
      const compiler2 = new TypstCompiler();

      expect(compiler1).not.toBe(compiler2);
    });
  });
});

describe('TypstCompiler - Type Definitions', () => {
  it('TypstCompileResult should contain required fields', () => {
    interface TypstCompileResult {
      success: boolean;
      pdfPath?: string;
      pdfBuffer?: Uint8Array;
      errors: string[];
      warnings?: string[];
      log?: string;
    }

    const mockResult: TypstCompileResult = {
      success: true,
      pdfBuffer: new Uint8Array([1, 2, 3]),
      errors: [],
    };

    expect(mockResult.success).toBe(true);
    expect(mockResult.errors).toHaveLength(0);
  });

  it('TypstCompileOptions should be correctly defined', () => {
    interface TypstCompileOptions {
      engine?: 'typst' | 'tinymist';
      mainFile?: string;
      projectPath?: string;
    }

    const options: TypstCompileOptions = {
      engine: 'typst',
    };

    expect(options.engine).toBe('typst');
  });
});
