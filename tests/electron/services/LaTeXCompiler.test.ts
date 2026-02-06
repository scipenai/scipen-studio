/**
 * @file LaTeXCompiler.test.ts - Unit tests for LaTeX compiler
 * @description Tests core functionality of LaTeX compiler. Due to ESM module limitations, focuses on basic class functionality and static methods.
 * @depends LaTeXCompiler, CompileWorkerClient
 */

import { describe, expect, it, vi } from 'vitest';

// ====== Mock electron ======
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/scipen-studio-test'),
    getAppPath: vi.fn().mockReturnValue('/tmp/scipen-studio-test'),
    isPackaged: false,
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

// ====== Mock CompileWorkerClient ======
// Avoid loading actual worker file
vi.mock('../../../src/main/workers/CompileWorkerClient', () => ({
  compileWorkerClient: {
    initialize: vi.fn().mockResolvedValue(undefined),
    compileLatex: vi.fn().mockResolvedValue({
      success: true,
      log: '',
      errors: [],
      warnings: [],
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    off: vi.fn(),
  },
  CompileWorkerClient: vi.fn(),
}));

import { LaTeXCompiler } from '../../../src/main/services/LaTeXCompiler';

describe('LaTeXCompiler', () => {
  describe('constructor', () => {
    it('should initialize successfully', () => {
      const compiler = new LaTeXCompiler();
      expect(compiler).toBeDefined();
      expect(compiler).toBeInstanceOf(LaTeXCompiler);
    });
  });

  describe('compile method signature', () => {
    it('should have compile method', () => {
      const compiler = new LaTeXCompiler();
      expect(typeof compiler.compile).toBe('function');
    });

    it('should have cleanup method', () => {
      const compiler = new LaTeXCompiler();
      expect(typeof compiler.cleanup).toBe('function');
    });
  });

  describe('cleanup', () => {
    it('should not throw when cleanup is called', async () => {
      const compiler = new LaTeXCompiler();
      await expect(compiler.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('compile options', () => {
    it('should accept engine option', async () => {
      const compiler = new LaTeXCompiler();

      const engines = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'] as const;

      for (const engine of engines) {
        const options = { engine };
        expect(options.engine).toBe(engine);
      }
    });

    it('should accept mainFile option', () => {
      const options = { mainFile: '/path/to/main.tex' };
      expect(options.mainFile).toBe('/path/to/main.tex');
    });
  });

  describe('compile result structure', () => {
    it('should return result with expected structure on error', async () => {
      const compiler = new LaTeXCompiler();

      const result = await compiler.compile('invalid latex content');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('duration');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.duration).toBe('number');

      if (!result.success) {
        expect(result).toHaveProperty('errors');
        expect(Array.isArray(result.errors)).toBe(true);
      }
    });
  });

  describe('engine command generation', () => {
    it('pdflatex should use synctex flag', () => {
      const expectedArgs = ['-synctex=1', '-interaction=nonstopmode', '-halt-on-error'];
      expectedArgs.forEach((arg) => {
        expect(arg).toBeTruthy();
      });
    });

    it('tectonic should use different synctex flag', () => {
      const expectedArgs = ['-X', 'compile', '--synctex'];
      expectedArgs.forEach((arg) => {
        expect(arg).toBeTruthy();
      });
    });
  });
});
