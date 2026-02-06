/**
 * @file AtMentionProcessor - @ File Reference Processor
 * @description Parses @ file/directory references in user input, reads content and injects into context
 * @depends IFileSystemService, PathSecurityService, LoggerService
 *
 * Supported syntax:
 * - @file.txt        - Reference file in current directory
 * - @path/to/file    - Reference relative path file
 * - @/absolute/path  - Reference absolute path file
 * - @folder/         - Reference directory (expands to all files)
 * - @*.tex           - Reference matching files (glob pattern)
 */

import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../LoggerService';
import { PathSecurityService } from '../PathSecurityService';
import type { IFileSystemService } from '../interfaces/IFileSystemService';

const logger = createLogger('AtMentionProcessor');

// ====== Type Definitions ======

/** @ mention parsing result */
export interface AtMention {
  /** Original matched text (e.g., @file.txt) */
  raw: string;
  /** Parsed path */
  path: string;
  /** Start index in original text */
  startIndex: number;
  /** End index in original text */
  endIndex: number;
  /** Whether it's a directory reference */
  isDirectory: boolean;
  /** Whether it's a glob pattern */
  isGlob: boolean;
}

/** Resolved file content */
export interface ResolvedFile {
  /** File path (relative to project root) */
  relativePath: string;
  /** File content */
  content: string;
  /** Whether content was truncated */
  truncated: boolean;
  /** Token estimate */
  tokenEstimate: number;
}

/** Processing result */
export interface AtMentionResult {
  /** Original text with @ mentions removed */
  cleanedText: string;
  /** Resolved files */
  files: ResolvedFile[];
  /** Failed references (path doesn't exist or was ignored) */
  failed: Array<{ path: string; reason: string }>;
  /** Formatted context (can be directly injected into prompt) */
  formattedContext: string;
}

/** Configuration options */
export interface AtMentionProcessorOptions {
  /** Maximum number of files */
  maxFiles?: number;
  /** Maximum characters per file */
  maxFileChars?: number;
  /** Maximum total characters */
  maxTotalChars?: number;
  /** Respect .gitignore */
  respectGitIgnore?: boolean;
  /** Allow absolute paths */
  allowAbsolutePath?: boolean;
  /** Include hidden files (starting with .) */
  includeHiddenFiles?: boolean;
}

// ====== Constants ======

const DEFAULT_OPTIONS: Required<AtMentionProcessorOptions> = {
  maxFiles: 10,
  maxFileChars: 50000,
  maxTotalChars: 100000,
  respectGitIgnore: true,
  allowAbsolutePath: false,
  includeHiddenFiles: true, // Default: allow referencing hidden files
};

/** Estimated tokens per character */
const CHARS_PER_TOKEN = 3;

// ====== Main Class ======

/**
 * @ mention processor
 */
export class AtMentionProcessor {
  private readonly options: Required<AtMentionProcessorOptions>;

  constructor(
    private readonly fileSystemService: IFileSystemService,
    options: AtMentionProcessorOptions = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ====== Public API ======

  /**
   * Process user input, parse @ mentions and read file content
   *
   * @param text User input text
   * @param projectPath Project root directory (optional, defaults to current project)
   * @returns Processing result
   */
  async process(text: string, projectPath?: string): Promise<AtMentionResult> {
    const basePath = projectPath || PathSecurityService.getProjectPath();
    if (!basePath) {
      logger.warn('[AtMentionProcessor] No open project');
      return {
        cleanedText: text,
        files: [],
        failed: [],
        formattedContext: '',
      };
    }

    // 1. Parse all @ mentions
    const mentions = this.parseAtMentions(text);
    if (mentions.length === 0) {
      return {
        cleanedText: text,
        files: [],
        failed: [],
        formattedContext: '',
      };
    }

    logger.info(`[AtMentionProcessor] Found ${mentions.length} @ mentions`);

    // 2. Resolve paths and read files
    const files: ResolvedFile[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    let totalChars = 0;

    for (const mention of mentions) {
      if (files.length >= this.options.maxFiles) {
        failed.push({ path: mention.path, reason: 'Exceeded max file limit' });
        continue;
      }

      try {
        const resolvedFiles = await this.resolveMention(mention, basePath);

        for (const file of resolvedFiles) {
          if (files.length >= this.options.maxFiles) {
            failed.push({ path: file.relativePath, reason: 'Exceeded max file limit' });
            continue;
          }

          if (totalChars + file.content.length > this.options.maxTotalChars) {
            // Truncate
            const remaining = this.options.maxTotalChars - totalChars;
            if (remaining > 100) {
              file.content = this.truncateContent(file.content, remaining);
              file.truncated = true;
              file.tokenEstimate = this.estimateTokens(file.content);
              files.push(file);
              totalChars += file.content.length;
            }
            failed.push({ path: file.relativePath, reason: 'Exceeded total character limit' });
            break;
          }

          files.push(file);
          totalChars += file.content.length;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        failed.push({ path: mention.path, reason });
        logger.warn(`[AtMentionProcessor] Resolution failed: ${mention.path} - ${reason}`);
      }
    }

    // 3. Remove @ mentions, build cleaned text
    const cleanedText = this.removeAtMentions(text, mentions);

    // 4. Format context
    const formattedContext = this.formatContext(files, failed);

    logger.info(
      `[AtMentionProcessor] Processing complete: ${files.length} files, ${failed.length} failed, ${totalChars} characters`
    );

    return {
      cleanedText,
      files,
      failed,
      formattedContext,
    };
  }

  /**
   * Parse all @ mentions in text
   */
  parseAtMentions(text: string): AtMention[] {
    const mentions: AtMention[] = [];
    let currentIndex = 0;

    while (currentIndex < text.length) {
      let atIndex = -1;
      let searchIndex = currentIndex;

      while (searchIndex < text.length) {
        if (text[searchIndex] === '@' && (searchIndex === 0 || text[searchIndex - 1] !== '\\')) {
          atIndex = searchIndex;
          break;
        }
        searchIndex++;
      }

      if (atIndex === -1) break;

      let pathEndIndex = atIndex + 1;
      let inEscape = false;

      while (pathEndIndex < text.length) {
        const char = text[pathEndIndex];

        if (inEscape) {
          inEscape = false;
          pathEndIndex++;
          continue;
        }

        if (char === '\\') {
          inEscape = true;
          pathEndIndex++;
          continue;
        }

        if (/[\s,;!?()[\]{}'"<>]/.test(char)) {
          break;
        }

        // Stop at period if followed by whitespace or end (allows file extensions like .txt)
        if (char === '.') {
          const nextChar = pathEndIndex + 1 < text.length ? text[pathEndIndex + 1] : '';
          if (nextChar === '' || /\s/.test(nextChar)) {
            break;
          }
        }

        pathEndIndex++;
      }

      const raw = text.substring(atIndex, pathEndIndex);
      const pathPart = this.unescapePath(raw.substring(1));

      if (!pathPart || pathPart.trim() === '') {
        currentIndex = pathEndIndex;
        continue;
      }

      const isDirectory = pathPart.endsWith('/') || pathPart.endsWith('\\');
      const isGlob = pathPart.includes('*') || pathPart.includes('?');

      mentions.push({
        raw,
        path: pathPart,
        startIndex: atIndex,
        endIndex: pathEndIndex,
        isDirectory,
        isGlob,
      });

      currentIndex = pathEndIndex;
    }

    return mentions;
  }

  /**
   * Resolve a single @ mention and return matching files
   */
  private async resolveMention(mention: AtMention, basePath: string): Promise<ResolvedFile[]> {
    const files: ResolvedFile[] = [];

    let targetPath = mention.path;

    if (mention.isDirectory) {
      targetPath = targetPath.replace(/[/\\]$/, '');
    }

    let absolutePath: string;
    if (path.isAbsolute(targetPath)) {
      if (!this.options.allowAbsolutePath) {
        throw new Error('Absolute paths are not allowed');
      }
      absolutePath = targetPath;
    } else {
      absolutePath = path.resolve(basePath, targetPath);
    }

    const securityCheck = PathSecurityService.checkPathStrict(absolutePath);
    if (!securityCheck.allowed) {
      throw new Error(`Path security check failed: ${securityCheck.reason}`);
    }

    const safePath = securityCheck.sanitizedPath ?? absolutePath;

    if (mention.isGlob) {
      // Glob pattern - simplified implementation, only supports *.ext format
      const dirPath = path.dirname(safePath);
      const pattern = path.basename(safePath);
      const matches = await this.matchFiles(dirPath, pattern, basePath);

      for (const match of matches.slice(0, this.options.maxFiles)) {
        const file = await this.readFile(match, basePath);
        if (file) files.push(file);
      }
    } else if (mention.isDirectory) {
      // Directory: expand to all files
      const matches = await this.listFilesRecursive(safePath, basePath);

      for (const match of matches.slice(0, this.options.maxFiles)) {
        const file = await this.readFile(match, basePath);
        if (file) files.push(file);
      }
    } else {
      // Single file
      const file = await this.readFile(safePath, basePath);
      if (file) files.push(file);
    }

    return files;
  }

  /**
   * Read single file
   */
  private async readFile(absolutePath: string, basePath: string): Promise<ResolvedFile | null> {
    try {
      const { content } = await this.fileSystemService.readFile(absolutePath);
      const relativePath = path.relative(basePath, absolutePath);

      let finalContent = content;
      let truncated = false;

      if (content.length > this.options.maxFileChars) {
        finalContent = this.truncateContent(content, this.options.maxFileChars);
        truncated = true;
      }

      return {
        relativePath,
        content: finalContent,
        truncated,
        tokenEstimate: this.estimateTokens(finalContent),
      };
    } catch (err) {
      logger.warn(`[AtMentionProcessor] Failed to read file: ${absolutePath}`, err);
      return null;
    }
  }

  /**
   * Recursively list all files in directory
   */
  private async listFilesRecursive(dirPath: string, basePath: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        // Skip ignored directories
        if (this.shouldIgnore(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.listFilesRecursive(fullPath, basePath);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }

        // Limit file count
        if (results.length >= this.options.maxFiles * 2) {
          break;
        }
      }
    } catch (err) {
      logger.warn(`[AtMentionProcessor] Failed to read directory: ${dirPath}`, err);
    }

    return results;
  }

  /**
   * Simple glob matching (supports *.ext format)
   */
  private async matchFiles(dirPath: string, pattern: string, _basePath: string): Promise<string[]> {
    const results: string[] = [];

    // Convert glob pattern to regex
    const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`, 'i');

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && regex.test(entry.name)) {
          results.push(path.join(dirPath, entry.name));
        }

        if (results.length >= this.options.maxFiles) {
          break;
        }
      }
    } catch (err) {
      logger.warn(`[AtMentionProcessor] Failed to match files: ${dirPath}/${pattern}`, err);
    }

    return results;
  }

  /**
   * Check if path should be ignored
   */
  private shouldIgnore(name: string): boolean {
    // Always ignored directories (regardless of config)
    const alwaysIgnorePatterns = ['node_modules', '.git', '.svn', '.hg', '__pycache__'];

    if (alwaysIgnorePatterns.includes(name)) {
      return true;
    }

    // Hidden files/directories (based on config)
    if (name.startsWith('.') && !this.options.includeHiddenFiles) {
      return true;
    }

    return false;
  }

  /**
   * Remove @ mentions from text
   */
  private removeAtMentions(text: string, mentions: AtMention[]): string {
    // Remove from end to start to avoid index changes
    const sorted = [...mentions].sort((a, b) => b.startIndex - a.startIndex);
    let result = text;

    for (const mention of sorted) {
      result = result.substring(0, mention.startIndex) + result.substring(mention.endIndex);
    }

    // Clean up extra whitespace
    return result.replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Format context
   */
  private formatContext(
    files: ResolvedFile[],
    failed: Array<{ path: string; reason: string }>
  ): string {
    if (files.length === 0 && failed.length === 0) {
      return '';
    }

    const parts: string[] = [];

    // Add file contents
    if (files.length > 0) {
      parts.push('<referenced_files>');

      for (const file of files) {
        parts.push(
          `<file path="${file.relativePath}"${file.truncated ? ' truncated="true"' : ''}>`
        );
        parts.push(file.content);
        parts.push('</file>');
        parts.push('');
      }

      parts.push('</referenced_files>');
    }

    // Add failure info (as comment, doesn't affect LLM understanding)
    if (failed.length > 0) {
      parts.push('');
      parts.push('<!-- Failed to load files:');
      for (const f of failed) {
        parts.push(`  - ${f.path}: ${f.reason}`);
      }
      parts.push('-->');
    }

    return parts.join('\n');
  }

  /**
   * Truncate content
   */
  private truncateContent(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }

    // Try to truncate at line boundary
    const lines = content.split('\n');
    let result = '';

    for (const line of lines) {
      if (result.length + line.length + 1 > maxChars) {
        break;
      }
      result += (result ? '\n' : '') + line;
    }

    if (result.length === 0) {
      result = content.substring(0, maxChars);
    }

    return `${result}\n\n[... content truncated, ${content.length - result.length} characters omitted ...]`;
  }

  /**
   * Estimate token count
   */
  private estimateTokens(content: string): number {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  /**
   * Process escape characters
   */
  private unescapePath(pathStr: string): string {
    return pathStr
      .replace(/\\ /g, ' ') // Escaped space -> space
      .replace(/\\\\/g, '\\'); // Escaped backslash -> backslash
  }
}
