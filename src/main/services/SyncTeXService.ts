/**
 * @file SyncTeXService - Bidirectional LaTeX/PDF synchronization
 * @description Uses external synctex CLI for forward/inverse sync with path normalization
 * @depends synctex CLI, fsCompat
 */

// ====== Design Notes ======
// Forward sync (source -> PDF): highlight PDF position for a source line.
// Inverse sync (PDF -> source): jump to source line for a PDF click.
//
// Why use external synctex CLI instead of parsing .synctex.gz?
// - synctex is a TeX Live/MiKTeX standard tool with stable output formats
// - parsing .synctex.gz requires a full parser (~500 lines) to be correct
// - CLI overhead (~10ms) is negligible for user experience
//
// Path normalization:
// - Windows paths in synctex output use lowercase drive letters with forward slashes
// - normalize paths before invoking synctex to avoid mismatches

import { spawn } from 'child_process';
import path from 'path';
import zlib from 'zlib';
import { augmentedEnv } from '../utils/shellEnv';
import type { ForwardSyncResult, ISyncTeXService, InverseSyncResult } from './interfaces';
import fs from './knowledge/utils/fsCompat';

// Re-export types for backward compatibility
export type { ForwardSyncResult, InverseSyncResult } from './interfaces';

export interface SyncTeXPosition {
  page: number;
  h: number; // horizontal position (in PDF points)
  v: number; // vertical position (in PDF points)
  width: number;
  height: number;
}

export interface SyncTeXSourceLocation {
  file: string;
  line: number;
  column: number;
}

export class SyncTeXService implements ISyncTeXService {
  private synctexPath = 'synctex';

  /** @sideeffect Spawns synctex CLI */
  async forwardSync(
    synctexFile: string,
    sourceFile: string,
    line: number,
    column = 0
  ): Promise<ForwardSyncResult | null> {
    // Derive PDF path from synctex file path.
    const dir = path.dirname(synctexFile);
    const baseName = path.basename(synctexFile).replace(/\.synctex(\.gz)?$/, '');
    const pdfFile = path.join(dir, `${baseName}.pdf`);

    if (!(await fs.pathExists(pdfFile))) {
      console.warn('PDF file not found:', pdfFile);
      return null;
    }

    // synctex records full paths using lowercase drive letters and forward slashes.
    // Normalize Windows paths before invoking synctex to avoid mismatches.
    const normalizedSourceFile = sourceFile
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`);

    return new Promise((resolve) => {
      // synctex view -i "line:column:input" -o "output.pdf"
      // -o is the PDF path; synctex locates the matching .synctex(.gz) file.
      const args = ['view', '-i', `${line}:${column}:${normalizedSourceFile}`, '-o', pdfFile];

      const proc = spawn(this.synctexPath, args, {
        cwd: dir,
        env: augmentedEnv,
      });
      let output = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', () => {
        resolve(this.parseViewOutput(output));
      });

      proc.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          console.warn('SyncTeX not found. Install TeX Live or MiKTeX.');
        } else {
          console.error('SyncTeX error:', error);
        }
        resolve(null);
      });
    });
  }

  /** @sideeffect Spawns synctex CLI */
  async inverseSync(
    synctexFile: string,
    page: number,
    x: number,
    y: number
  ): Promise<InverseSyncResult | null> {
    if (!synctexFile) {
      return null;
    }

    // Derive PDF path from synctex file path.
    const dir = path.dirname(synctexFile);
    const baseName = path.basename(synctexFile).replace(/\.synctex(\.gz)?$/, '');
    const pdfFile = path.join(dir, `${baseName}.pdf`);

    if (!(await fs.pathExists(pdfFile))) {
      console.warn('PDF file not found:', pdfFile);
      return null;
    }

    if (!(await fs.pathExists(synctexFile))) {
      console.warn('SyncTeX file not found:', synctexFile);
      return null;
    }

    return new Promise((resolve) => {
      const args = ['edit', '-o', `${page}:${x}:${y}:${pdfFile}`];

      const proc = spawn(this.synctexPath, args, {
        cwd: dir,
        env: augmentedEnv,
      });
      let output = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', () => {
        const result = this.parseEditOutput(output);
        if (result) {
          // Normalize relative file path to absolute.
          if (result.file && !path.isAbsolute(result.file)) {
            result.file = path.join(dir, result.file);
          }
        }
        resolve(result);
      });

      proc.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          console.warn('SyncTeX not found. Install TeX Live or MiKTeX.');
        } else {
          console.error('SyncTeX error:', error);
        }
        resolve(null);
      });
    });
  }

  private async findSynctexFile(filePath: string): Promise<string | null> {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath).replace(/\.(pdf|tex)$/, '');

    // Try different possible synctex file locations
    const candidates = [
      path.join(dir, `${baseName}.synctex.gz`),
      path.join(dir, `${baseName}.synctex`),
    ];

    for (const candidate of candidates) {
      if (await fs.pathExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Parses synctex "view" output.
   *
   * Based on Overleaf's SynctexOutputParser.parseViewOutput.
   *
   * Why support multiple coordinate keys?
   * - synctex output varies slightly across versions
   * - some outputs use x/y, others use h/v (horizontal/vertical)
   * - keep compatibility across TeX Live and MiKTeX
   *
   * Why return only the first match?
   * - synctex may return multiple blocks (e.g., multi-line equations)
   * - the first match is usually the most accurate anchor
   */
  private parseViewOutput(output: string): ForwardSyncResult | null {
    const result: Partial<ForwardSyncResult> = {};

    // Normalize CRLF and trim line endings.
    const lines = output
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim());

    for (const line of lines) {
      // Match "Page:<number>" (line already trimmed).
      const pageMatch = line.match(/^Page:(\d+)/);
      if (pageMatch) {
        result.page = Number.parseInt(pageMatch[1], 10);
        continue;
      }

      const xMatch = line.match(/^x:(-?\d+\.?\d*)/);
      if (xMatch) {
        result.x = Number.parseFloat(xMatch[1]);
        continue;
      }

      const yMatch = line.match(/^y:(-?\d+\.?\d*)/);
      if (yMatch) {
        result.y = Number.parseFloat(yMatch[1]);
        continue;
      }

      const hMatch = line.match(/^h:(-?\d+\.?\d*)/);
      if (hMatch) {
        // Use h as x when x is missing.
        if (result.x === undefined) {
          result.x = Number.parseFloat(hMatch[1]);
        }
        continue;
      }

      const vMatch = line.match(/^v:(-?\d+\.?\d*)/);
      if (vMatch) {
        // Use v as y when y is missing.
        if (result.y === undefined) {
          result.y = Number.parseFloat(vMatch[1]);
        }
        continue;
      }

      const wMatch = line.match(/^W:(-?\d+\.?\d*)/);
      if (wMatch) {
        result.width = Number.parseFloat(wMatch[1]);
        continue;
      }

      const heightMatch = line.match(/^H:(-?\d+\.?\d*)/);
      if (heightMatch) {
        result.height = Number.parseFloat(heightMatch[1]);
        continue;
      }

      // Break once the first complete result is found.
      if (
        result.page !== undefined &&
        result.x !== undefined &&
        result.y !== undefined &&
        result.width !== undefined &&
        result.height !== undefined
      ) {
        break;
      }
    }

    if (result.page !== undefined && result.x !== undefined && result.y !== undefined) {
      return {
        page: result.page,
        x: result.x,
        y: result.y,
        width: result.width || 0,
        height: result.height || 0,
      };
    }

    return null;
  }

  /**
   * Parse synctex edit command output
   *
   * Based on Overleaf's SynctexOutputParser.parseEditOutput
   */
  private parseEditOutput(output: string): InverseSyncResult | null {
    const result: Partial<InverseSyncResult> = {};

    // Normalize line endings and trim whitespace (handles Windows CRLF).
    const lines = output
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim());

    for (const line of lines) {
      // Input file
      const inputMatch = line.match(/^Input:(.+)$/);
      if (inputMatch) {
        result.file = inputMatch[1].trim();
        continue;
      }

      // Line number
      const lineMatch = line.match(/^Line:(\d+)$/);
      if (lineMatch) {
        result.line = Number.parseInt(lineMatch[1], 10);
        continue;
      }

      // Column number
      const columnMatch = line.match(/^Column:(-?\d+)$/);
      if (columnMatch) {
        result.column = Math.max(0, Number.parseInt(columnMatch[1], 10));
      }
    }

    if (result.file && result.line !== undefined) {
      return {
        file: result.file,
        line: result.line,
        column: result.column || 0,
      };
    }

    return null;
  }

  async parseSynctexFile(filePath: string): Promise<unknown> {
    const synctexPath = await this.findSynctexFile(filePath);
    if (!synctexPath) {
      throw new Error('SyncTeX file not found');
    }

    let content: string;

    if (synctexPath.endsWith('.gz')) {
      const compressed = await fs.readFile(synctexPath);
      const decompressed = zlib.gunzipSync(compressed);
      content = decompressed.toString('utf-8');
    } else {
      content = await fs.readFile(synctexPath, 'utf-8');
    }

    // Parse synctex format
    // This is a simplified parser - full implementation would need more work
    const lines = content.split('\n');
    const files: Map<number, string> = new Map();
    // SyncTeX block structure (reserved for future use).
    const blocks: Array<{ page: number; x: number; y: number; fileId: number; line: number }> = [];

    for (const line of lines) {
      // Input file definition
      if (line.startsWith('Input:')) {
        const match = line.match(/^Input:(\d+):(.+)$/);
        if (match) {
          files.set(Number.parseInt(match[1], 10), match[2]);
        }
      }
    }

    return { files, blocks };
  }
}

export function createSyncTeXService(): ISyncTeXService {
  return new SyncTeXService();
}
