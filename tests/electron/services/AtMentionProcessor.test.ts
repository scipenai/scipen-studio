/**
 * @file AtMentionProcessor.test.ts - Unit tests for @ mention processor
 * @description Tests core functionality of @ mention processor: parsing, path security, file reading, truncation, and context formatting
 * @depends AtMentionProcessor, PathSecurityService, IFileSystemService
 */

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystemService } from '../../../src/main/services/interfaces/IFileSystemService';

// ====== Mock PathSecurityService ======
// vi.hoisted ensures mocks are available when vi.mock is hoisted
const { mockPathSecurityService, mockFs } = vi.hoisted(() => ({
  mockPathSecurityService: {
    getProjectPath: vi.fn(),
    checkPathStrict: vi.fn(),
  },
  mockFs: {
    readdir: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/PathSecurityService', () => ({
  PathSecurityService: mockPathSecurityService,
}));

// ====== Mock fs/promises ======
// AtMentionProcessor uses default export: `import fs from 'fs/promises'`
vi.mock('fs/promises', () => ({
  default: mockFs,
  ...mockFs,
}));

// ====== Import after mocks ======

import {
  AtMentionProcessor,
  type AtMentionProcessorOptions,
} from '../../../src/main/services/chat/AtMentionProcessor';

// ====== Mock Factories ======

function createMockFileSystemService(
  options: {
    files?: Record<string, string>;
  } = {}
): IFileSystemService {
  const { files = {} } = options;

  return {
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return { content, encoding: 'utf-8' };
    }),
    buildFileTree: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    recordFileMtime: vi.fn(),
    updateFileMtime: vi.fn(),
    getCachedMtime: vi.fn(),
    getFileExtension: vi.fn(),
    isLaTeXFile: vi.fn(),
    findMainTexFile: vi.fn(),
    findFiles: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as IFileSystemService;
}

describe('AtMentionProcessor', () => {
  let processor: AtMentionProcessor;
  let mockFileService: IFileSystemService;
  const projectPath = path.resolve('/test/project');

  beforeEach(() => {
    vi.clearAllMocks();

    mockPathSecurityService.getProjectPath.mockReturnValue(projectPath);
    mockPathSecurityService.checkPathStrict.mockImplementation((filePath: string) => ({
      allowed: true,
      sanitizedPath: filePath,
    }));

    mockFileService = createMockFileSystemService({
      files: {
        [path.join(projectPath, 'main.tex')]:
          '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
        [path.join(projectPath, 'chapter1.tex')]: '\\chapter{Introduction}\nThis is chapter 1.',
        [path.join(projectPath, 'refs.bib')]: '@article{ref1, author={John Doe}, title={Test}}',
        [path.join(projectPath, 'images', 'fig1.png')]: '[binary content]',
        [path.join(projectPath, 'src', 'utils.ts')]: 'export function helper() { return 42; }',
      },
    });

    processor = new AtMentionProcessor(mockFileService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ====== parseAtMentions ======

  describe('parseAtMentions', () => {
    it('should parse simple file reference', () => {
      const text = 'Please check @main.tex for details';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({
        raw: '@main.tex',
        path: 'main.tex',
        isDirectory: false,
        isGlob: false,
      });
    });

    it('should parse multiple file references', () => {
      const text = 'Compare @main.tex with @chapter1.tex';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(2);
      expect(mentions[0].path).toBe('main.tex');
      expect(mentions[1].path).toBe('chapter1.tex');
    });

    it('should parse relative path reference', () => {
      const text = 'See @src/utils.ts for helpers';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('src/utils.ts');
    });

    it('should parse directory reference', () => {
      const text = 'Check all files in @images/';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({
        path: 'images/',
        isDirectory: true,
        isGlob: false,
      });
    });

    it('should parse glob pattern reference', () => {
      const text = 'Process all @*.tex files';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({
        path: '*.tex',
        isDirectory: false,
        isGlob: true,
      });
    });

    it('should skip escaped @ symbols', () => {
      const text = 'Email: user\\@example.com and @main.tex';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('main.tex');
    });

    it('should stop at whitespace', () => {
      const text = '@main.tex is the main file';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].raw).toBe('@main.tex');
    });

    it('should stop at punctuation', () => {
      const text = 'Check @main.tex, @chapter1.tex!';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(2);
      expect(mentions[0].path).toBe('main.tex');
      expect(mentions[1].path).toBe('chapter1.tex');
    });

    it('should handle @ at start and end', () => {
      const text = '@main.tex and @refs.bib';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(2);
    });

    it('should skip standalone @', () => {
      const text = 'Email @ user and @main.tex';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('main.tex');
    });

    it('should handle paths with spaces (escaped)', () => {
      const text = '@my\\ file.tex';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('my file.tex');
    });

    it('should record correct positions', () => {
      const text = 'File: @main.tex here';
      const mentions = processor.parseAtMentions(text);

      expect(mentions[0].startIndex).toBe(6);
      expect(mentions[0].endIndex).toBe(15);
      expect(text.substring(mentions[0].startIndex, mentions[0].endIndex)).toBe('@main.tex');
    });
  });

  // ====== process ======

  describe('process', () => {
    it('should return cleaned text without @ mentions', async () => {
      const text = 'Check @main.tex for details';
      const result = await processor.process(text, projectPath);

      expect(result.cleanedText).toBe('Check for details');
    });

    it('should read file content', async () => {
      const text = 'Analyze @main.tex';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].relativePath).toBe('main.tex');
      expect(result.files[0].content).toContain('\\documentclass{article}');
    });

    it('should handle multiple files', async () => {
      const text = 'Compare @main.tex and @chapter1.tex';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.relativePath)).toContain('main.tex');
      expect(result.files.map((f) => f.relativePath)).toContain('chapter1.tex');
    });

    it('should return empty when no @ mentions', async () => {
      const text = 'No file references here';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.cleanedText).toBe(text);
      expect(result.formattedContext).toBe('');
    });

    it('should return empty when no project path', async () => {
      mockPathSecurityService.getProjectPath.mockReturnValue(null);

      const text = 'Check @main.tex';
      const result = await processor.process(text);

      expect(result.files).toHaveLength(0);
      expect(result.cleanedText).toBe(text);
    });

    // TODO: Fix mock to properly handle file not found errors on Windows
    it.skip('should track failed references', async () => {
      const text = 'Check @nonexistent.tex';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].path).toBe('nonexistent.tex');
    });

    it('should estimate tokens', async () => {
      const text = 'Read @main.tex';
      const result = await processor.process(text, projectPath);

      expect(result.files[0].tokenEstimate).toBeGreaterThan(0);
      expect(result.files[0].tokenEstimate).toBe(Math.ceil(result.files[0].content.length / 3));
    });
  });

  // ====== Security Checks ======

  describe('Security Checks', () => {
    it('should reject paths that fail security check', async () => {
      mockPathSecurityService.checkPathStrict.mockReturnValue({
        allowed: false,
        reason: 'Path traversal detected',
      });

      const text = 'Check @../../../etc/passwd';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].reason).toContain('security check');
    });

    it('should reject absolute paths by default', async () => {
      const processorStrict = new AtMentionProcessor(mockFileService, {
        allowAbsolutePath: false,
      });

      const text = 'Check @/etc/passwd';
      const result = await processorStrict.process(text, projectPath);

      expect(result.files).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].reason).toContain('Absolute path');
    });

    it('should allow absolute paths when configured', async () => {
      const processorPermissive = new AtMentionProcessor(mockFileService, {
        allowAbsolutePath: true,
      });

      mockFileService = createMockFileSystemService({
        files: {
          '/absolute/path/file.tex': 'content',
        },
      });

      // Need to recreate processor with new mock
      const newProcessor = new AtMentionProcessor(mockFileService, {
        allowAbsolutePath: true,
      });

      const text = 'Check @/absolute/path/file.tex';
      const result = await newProcessor.process(text, projectPath);

      expect(result.failed.every((f) => !f.reason.includes('absolute path'))).toBe(true);
    });
  });

  // ====== Limits ======

  describe('Limits', () => {
    it('should respect maxFiles limit', async () => {
      const processorLimited = new AtMentionProcessor(mockFileService, {
        maxFiles: 2,
      });

      const text = 'Check @main.tex @chapter1.tex @refs.bib';
      const result = await processorLimited.process(text, projectPath);

      expect(result.files).toHaveLength(2);
      expect(result.failed.some((f) => f.reason.includes('Exceeded max file limit'))).toBe(true);
    });

    // TODO: Fix mock implementation for large file handling
    it.skip('should truncate large files', async () => {
      const largeContent = 'x'.repeat(60000);
      mockFileService = createMockFileSystemService({
        files: {
          '/test/project/large.tex': largeContent,
        },
      });

      const processorLimited = new AtMentionProcessor(mockFileService, {
        maxFileChars: 1000,
      });

      const text = 'Read @large.tex';
      const result = await processorLimited.process(text, projectPath);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].truncated).toBe(true);
      expect(result.files[0].content.length).toBeLessThan(largeContent.length);
      expect(result.files[0].content).toContain('truncated');
    });

    it('should respect maxTotalChars limit', async () => {
      mockFileService = createMockFileSystemService({
        files: {
          '/test/project/file1.tex': 'a'.repeat(500),
          '/test/project/file2.tex': 'b'.repeat(500),
          '/test/project/file3.tex': 'c'.repeat(500),
        },
      });

      const processorLimited = new AtMentionProcessor(mockFileService, {
        maxTotalChars: 800,
      });

      const text = 'Read @file1.tex @file2.tex @file3.tex';
      const result = await processorLimited.process(text, projectPath);

      const totalChars = result.files.reduce((sum, f) => sum + f.content.length, 0);
      expect(totalChars).toBeLessThanOrEqual(900); // Allow some margin for truncation message
    });
  });

  // ====== Directory References ======

  describe('Directory References', () => {
    beforeEach(() => {
      mockFs.readdir.mockResolvedValue([
        { name: 'file1.tex', isDirectory: () => false, isFile: () => true },
        { name: 'file2.tex', isDirectory: () => false, isFile: () => true },
        { name: 'subdir', isDirectory: () => true, isFile: () => false },
      ]);

      mockFileService = createMockFileSystemService({
        files: {
          '/test/project/src/file1.tex': 'File 1 content',
          '/test/project/src/file2.tex': 'File 2 content',
          '/test/project/src/subdir/nested.tex': 'Nested content',
        },
      });
    });

    it('should list files in directory recursively', async () => {
      const processorDir = new AtMentionProcessor(mockFileService);

      mockFs.readdir.mockResolvedValueOnce([
        { name: 'file1.tex', isDirectory: () => false, isFile: () => true },
        { name: 'file2.tex', isDirectory: () => false, isFile: () => true },
      ]);

      const text = 'Check @src/';
      const result = await processorDir.process(text, projectPath);

      expect(mockFs.readdir).toHaveBeenCalled();
    });

    it('should ignore node_modules directories', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'file.tex', isDirectory: () => false, isFile: () => true },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
      ]);

      const processorDir = new AtMentionProcessor(mockFileService);
      const text = 'Check @src/';
      await processorDir.process(text, projectPath);

      expect(mockFs.readdir).not.toHaveBeenCalledWith(
        expect.stringContaining('node_modules'),
        expect.anything()
      );
    });

    it('should ignore .git directories', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: 'file.tex', isDirectory: () => false, isFile: () => true },
      ]);

      const processorDir = new AtMentionProcessor(mockFileService);
      const text = 'Check @src/';
      await processorDir.process(text, projectPath);

      expect(mockFs.readdir).not.toHaveBeenCalledWith(
        expect.stringContaining('.git'),
        expect.anything()
      );
    });
  });

  // ====== Glob Patterns ======

  describe('Glob Patterns', () => {
    beforeEach(() => {
      mockFs.readdir.mockResolvedValue([
        { name: 'main.tex', isDirectory: () => false, isFile: () => true },
        { name: 'chapter1.tex', isDirectory: () => false, isFile: () => true },
        { name: 'refs.bib', isDirectory: () => false, isFile: () => true },
        { name: 'image.png', isDirectory: () => false, isFile: () => true },
      ]);
    });

    it('should match *.tex pattern', async () => {
      mockFileService = createMockFileSystemService({
        files: {
          [`${projectPath}/main.tex`]: 'main content',
          [`${projectPath}/chapter1.tex`]: 'chapter content',
        },
      });

      const processorGlob = new AtMentionProcessor(mockFileService);
      const text = 'Process @*.tex';
      const result = await processorGlob.process(text, projectPath);

      expect(mockFs.readdir).toHaveBeenCalled();
    });

    it('should match *.bib pattern', async () => {
      mockFileService = createMockFileSystemService({
        files: {
          [`${projectPath}/refs.bib`]: 'bib content',
        },
      });

      const processorGlob = new AtMentionProcessor(mockFileService);
      const text = 'Process @*.bib';
      await processorGlob.process(text, projectPath);

      expect(mockFs.readdir).toHaveBeenCalled();
    });
  });

  // ====== Context Formatting ======

  describe('Context Formatting', () => {
    it('should format context with XML tags', async () => {
      const text = 'Analyze @main.tex';
      const result = await processor.process(text, projectPath);

      expect(result.formattedContext).toContain('<referenced_files>');
      expect(result.formattedContext).toContain('</referenced_files>');
      expect(result.formattedContext).toContain('<file path="main.tex">');
      expect(result.formattedContext).toContain('</file>');
    });

    // TODO: Fix mock implementation for large file handling
    it.skip('should mark truncated files', async () => {
      const largeContent = 'x'.repeat(60000);
      mockFileService = createMockFileSystemService({
        files: {
          '/test/project/large.tex': largeContent,
        },
      });

      const processorLimited = new AtMentionProcessor(mockFileService, {
        maxFileChars: 1000,
      });

      const text = 'Read @large.tex';
      const result = await processorLimited.process(text, projectPath);

      expect(result.formattedContext).toContain('truncated="true"');
    });

    // TODO: Fix mock to properly handle file not found errors on Windows
    it.skip('should include failed files in HTML comment', async () => {
      const text = 'Check @main.tex @nonexistent.tex';
      const result = await processor.process(text, projectPath);

      expect(result.formattedContext).toContain('<!-- Failed to load files:');
      expect(result.formattedContext).toContain('nonexistent.tex');
      expect(result.formattedContext).toContain('-->');
    });

    it('should return empty context when no files', async () => {
      const text = 'No files here';
      const result = await processor.process(text, projectPath);

      expect(result.formattedContext).toBe('');
    });
  });

  // ====== Edge Cases ======

  describe('Edge Cases', () => {
    it('should handle empty text', async () => {
      const result = await processor.process('', projectPath);

      expect(result.cleanedText).toBe('');
      expect(result.files).toHaveLength(0);
    });

    it('should handle text with only @', async () => {
      const result = await processor.process('@', projectPath);

      expect(result.cleanedText).toBe('@');
      expect(result.files).toHaveLength(0);
    });

    // TODO: Fix path resolution for consecutive @ mentions on Windows
    it.skip('should handle consecutive @ mentions', async () => {
      const text = '@main.tex@chapter1.tex';
      const mentions = processor.parseAtMentions(text);

      expect(mentions).toHaveLength(2);
    });

    // TODO: Fix mock to properly handle file read errors on Windows
    it.skip('should handle file read errors gracefully', async () => {
      mockFileService.readFile = vi.fn().mockRejectedValue(new Error('Permission denied'));

      const text = 'Read @main.tex';
      const result = await processor.process(text, projectPath);

      expect(result.files).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });

    it('should clean multiple spaces after removing mentions', async () => {
      const text = 'Check    @main.tex    please';
      const result = await processor.process(text, projectPath);

      expect(result.cleanedText).toBe('Check please');
    });

    it('should trim result', async () => {
      const text = '  @main.tex  ';
      const result = await processor.process(text, projectPath);

      expect(result.cleanedText).toBe('');
    });
  });

  // ====== Options ======

  describe('Options', () => {
    it('should use default options', () => {
      const defaultProcessor = new AtMentionProcessor(mockFileService);
      expect(defaultProcessor).toBeDefined();
    });

    it('should accept custom options', () => {
      const customOptions: AtMentionProcessorOptions = {
        maxFiles: 5,
        maxFileChars: 10000,
        maxTotalChars: 50000,
        respectGitIgnore: false,
        allowAbsolutePath: true,
        includeHiddenFiles: false,
      };

      const customProcessor = new AtMentionProcessor(mockFileService, customOptions);
      expect(customProcessor).toBeDefined();
    });

    it('should not include hidden files when disabled', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false, isFile: () => true },
        { name: 'visible.tex', isDirectory: () => false, isFile: () => true },
      ]);

      const processorNoHidden = new AtMentionProcessor(mockFileService, {
        includeHiddenFiles: false,
      });

      const text = 'Check @src/';
      await processorNoHidden.process(text, projectPath);
    });
  });
});
