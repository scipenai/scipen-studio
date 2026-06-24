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
import { augmentedEnv } from '../utils/shellEnv';
import type { ForwardSyncResult, ISyncTeXService, InverseSyncResult } from './interfaces';
import fs from 'fs-extra';

// Re-export types for backward compatibility
export type { ForwardSyncResult, InverseSyncResult } from './interfaces';

/**
 * BusyTeX runs LaTeX inside an Emscripten MEMFS whose project directory
 * is hard-coded at `busytex_pipeline.js:201`:
 *   `this.project_dir = '/home/web_user/project_dir';`
 *
 * Every path BusyTeX emits into `.synctex.gz` is prefixed with this
 * MEMFS root — it looks like a POSIX absolute path but resolves nowhere
 * on the host. SyncTeX queries must translate between this namespace
 * and the user's actual project root in both directions:
 *   - forward : host-absolute  →  MEMFS-absolute  (synctex `-i` arg)
 *   - inverse : MEMFS-absolute →  host-absolute  (returned to renderer)
 */
const BUSYTEX_MEMFS_PROJECT_ROOT = '/home/web_user/project_dir';
const BUSYTEX_MEMFS_PROJECT_PREFIX = `${BUSYTEX_MEMFS_PROJECT_ROOT}/`;

export class SyncTeXService implements ISyncTeXService {
  private synctexPath = 'synctex';

  /** @sideeffect Spawns synctex CLI */
  async forwardSync(
    synctexFile: string,
    sourceFile: string,
    line: number,
    column = 0,
    projectRoot?: string
  ): Promise<ForwardSyncResult | null> {
    // Derive PDF path from synctex file path.
    const dir = path.dirname(synctexFile);
    const baseName = path.basename(synctexFile).replace(/\.synctex(\.gz)?$/, '');
    const pdfFile = path.join(dir, `${baseName}.pdf`);

    if (!(await fs.pathExists(pdfFile))) {
      console.warn('PDF file not found:', pdfFile);
      return null;
    }

    // BusyTeX-produced .synctex.gz records MEMFS absolute paths under
    // {@link BUSYTEX_MEMFS_PROJECT_ROOT}, not host paths. When projectRoot
    // is supplied (the engine returned it), rebase the renderer-supplied
    // host path into the MEMFS namespace so synctex CLI's `-i` argument
    // matches the entries inside the .synctex.gz file. CLI-compiled files
    // use real absolute paths and skip this branch entirely.
    let resolvedSource = sourceFile;
    if (projectRoot) {
      const rel = path.relative(projectRoot, sourceFile);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        resolvedSource = `${BUSYTEX_MEMFS_PROJECT_ROOT}/${rel.replace(/\\/g, '/')}`;
      }
    }

    // synctex records full paths using lowercase drive letters and forward slashes.
    // Normalize Windows paths before invoking synctex to avoid mismatches.
    const normalizedSourceFile = path.isAbsolute(resolvedSource)
      ? resolvedSource
          .replace(/\\/g, '/')
          .replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`)
      : resolvedSource;

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

      const timeout = setTimeout(() => {
        proc.kill();
        console.warn('SyncTeX forward timed out after 10s');
        resolve(null);
      }, 10_000);

      proc.on('close', () => {
        clearTimeout(timeout);
        resolve(this.parseViewOutput(output));
      });

      proc.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
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
    y: number,
    projectRoot?: string
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

      const timeout = setTimeout(() => {
        proc.kill();
        console.warn('SyncTeX backward timed out after 10s');
        resolve(null);
      }, 10_000);

      proc.on('close', () => {
        clearTimeout(timeout);
        const result = this.parseEditOutput(output);
        if (result?.file) {
          // BusyTeX emits MEMFS-absolute paths (see BUSYTEX_MEMFS_*).
          // Strip the prefix and rebase onto the user's projectRoot.
          // CLI-compiled builds skip this branch (no MEMFS prefix).
          if (result.file.startsWith(BUSYTEX_MEMFS_PROJECT_PREFIX) && projectRoot) {
            const rel = result.file.slice(BUSYTEX_MEMFS_PROJECT_PREFIX.length);
            result.file = path.join(projectRoot, rel);
          } else if (!path.isAbsolute(result.file)) {
            // CLI-compiled relative paths: anchor on projectRoot when
            // given, else the synctex file's own directory.
            const anchor = projectRoot ?? dir;
            result.file = path.join(anchor, result.file);
          }
        }
        resolve(result);
      });

      proc.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === 'ENOENT') {
          console.warn('SyncTeX not found. Install TeX Live or MiKTeX.');
        } else {
          console.error('SyncTeX error:', error);
        }
        resolve(null);
      });
    });
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
}

export function createSyncTeXService(): ISyncTeXService {
  return new SyncTeXService();
}
