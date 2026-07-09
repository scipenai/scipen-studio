/**
 * @file SyncTeXService.ts - Unified SyncTeX Service (renderer-side)
 * @description Holds the parsed SyncTeX source map for the currently displayed
 *   compile PDF and answers forward/reverse queries entirely in-process via
 *   {@link parseSynctex}. No external `synctex` CLI and no TeX install are
 *   required, so bidirectional sync works for WASM-only users too.
 *
 *   The source map is (re)loaded from the on-disk `.synctex.gz` whenever a
 *   compile finishes or an existing PDF is loaded from disk — always paired
 *   with the PDF being shown. Both CLI and BusyTeX WASM compiles write a
 *   `.synctex.gz` next to the PDF, so a single disk-bytes → JS-parse path
 *   covers every engine.
 */

import { api } from '../api';
import { createLogger } from './LogService';
import { getProjectService } from './core/ServiceRegistry';
import { type SyncTexSourceMap, parseSynctex } from './synctex/synctexParser';

const logger = createLogger('SyncTeXService');

/**
 * BusyTeX (WASM) records input paths under this MEMFS root instead of the
 * host path. Strip it to recover the project-relative path when mapping a
 * reverse-sync result back to an openable host file.
 */
const BUSYTEX_MEMFS_PREFIX = '/home/web_user/project_dir/';

export interface SyncTeXForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTeXBackwardResult {
  file: string;
  line: number;
  column: number;
}

const normalizeSlashes = (p: string): string => p.replace(/\\/g, '/');

export class SyncTeXService {
  private sourceMap: SyncTexSourceMap | null = null;
  /** Path of the map currently installed in {@link sourceMap}. */
  private loadedPath: string | null = null;
  /**
   * Monotonic request counter — the race token. Every load/clear takes the
   * next number and, after each `await`, drops its result unless it is still
   * the latest request. Unlike keying on the path, this orders even two
   * concurrent forced reloads of the SAME file (a rapid double-recompile), so
   * the singleton is genuinely last-request-wins regardless of disk-read
   * completion order.
   */
  private requestSeq = 0;

  /** Whether a source map is currently loaded (a PDF with usable synctex is shown). */
  isAvailable(): boolean {
    return this.sourceMap !== null;
  }

  /**
   * Load and parse the `.synctex.gz` at `synctexPath` into the in-memory
   * source map, replacing any previously loaded map. Skips work when the same
   * path is already loaded unless `force` is set (a recompile rewrites the
   * same path with new bytes). Concurrent calls are resolved last-request-wins
   * via {@link requestSeq}. Failures clear the map (sync becomes unavailable).
   */
  async loadFromPath(synctexPath: string | null | undefined, force = false): Promise<void> {
    if (!synctexPath) {
      this.clear();
      return;
    }

    // Take a sequence number only when we actually intend to load — a no-op
    // idempotent skip must NOT advance the token, or it would cancel a genuine
    // in-flight load of a newer path.
    if (!force && synctexPath === this.loadedPath && this.sourceMap) return;
    const seq = ++this.requestSeq;

    try {
      const buffer = await api.file.readBinary(synctexPath);
      if (seq !== this.requestSeq) return; // superseded during read
      const map = parseSynctex(new Uint8Array(buffer));
      if (seq !== this.requestSeq) return; // superseded during parse
      this.sourceMap = map;
      this.loadedPath = synctexPath;
    } catch (error) {
      logger.warn('Failed to load synctex source map', { synctexPath, error });
      if (seq === this.requestSeq) this.clear();
    }
  }

  clear(): void {
    this.sourceMap = null;
    this.loadedPath = null;
    // Bump so any in-flight load sees a newer request and drops its result.
    this.requestSeq++;
  }

  /**
   * Forward sync: source location → PDF highlight box.
   * Returns the bounding box (PDF points, top-left origin, Y-down) over all
   * rects synctex reports for the line, ready for `setPdfHighlight`.
   */
  forward(sourcePath: string, line: number): SyncTeXForwardResult | null {
    if (!this.sourceMap || !sourcePath) return null;

    const queryFile = this.toProjectRelative(sourcePath);
    const result = this.sourceMap.forward(queryFile, line);
    if (!result || result.rects.length === 0) return null;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const r of result.rects) {
      left = Math.min(left, r.x);
      top = Math.min(top, r.y);
      right = Math.max(right, r.x + r.width);
      bottom = Math.max(bottom, r.y + r.height);
    }

    return {
      page: result.page,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  /**
   * Reverse sync: PDF click (page + PDF-point coords, top-left origin) → source
   * location. The recorded file is mapped to an openable host path.
   */
  backward(page: number, x: number, y: number): SyncTeXBackwardResult | null {
    if (!this.sourceMap) return null;

    const result = this.sourceMap.reverse(page, x, y);
    if (!result) return null;

    return {
      file: this.toHostPath(result.file),
      line: result.line,
      column: result.column ?? 0,
    };
  }

  /** Convert a host-absolute source path to a project-relative path for matching. */
  private toProjectRelative(sourcePath: string): string {
    const projectPath = getProjectService().projectPath;
    if (!projectPath) return sourcePath;

    const proj = normalizeSlashes(projectPath).replace(/\/+$/, '');
    const src = normalizeSlashes(sourcePath);
    if (src.toLowerCase().startsWith(`${proj.toLowerCase()}/`)) {
      return src.slice(proj.length + 1);
    }
    return sourcePath;
  }

  /** Map a synctex-recorded file path to an openable host path. */
  private toHostPath(recorded: string): string {
    let host: string;
    if (recorded.startsWith(BUSYTEX_MEMFS_PREFIX)) {
      // BusyTeX MEMFS path → project-relative → anchor on host root.
      host = this.anchorRelative(recorded.slice(BUSYTEX_MEMFS_PREFIX.length));
    } else if (/^(?:[A-Za-z]:[\\/]|\/)/.test(recorded)) {
      // Already an absolute host path (CLI compiles).
      host = recorded;
    } else {
      // Relative path recorded by the compiler.
      host = this.anchorRelative(recorded.replace(/^\.?\/+/, ''));
    }
    // Canonicalize slashes and drop `/./` segments — TeX records e.g.
    // `/dir/./main.tex`; without this the returned path fails to string-match
    // an already-open tab's path and reverse sync opens a duplicate tab.
    return normalizeSlashes(host).replace(/\/\.\//g, '/');
  }

  /**
   * Anchor a project-relative path onto an openable absolute host path: prefer
   * the open project root, else fall back to the loaded synctex file's own
   * directory (both the PDF and synctex sit next to the sources), so reverse
   * sync still opens files when no project is active.
   */
  private anchorRelative(rel: string): string {
    const projectPath = getProjectService().projectPath;
    if (projectPath) return this.join(projectPath, rel);
    if (this.loadedPath) {
      const dir = normalizeSlashes(this.loadedPath).replace(/\/[^/]*$/, '');
      if (dir) return this.join(dir, rel);
    }
    return rel;
  }

  private join(base: string, rel: string): string {
    const b = normalizeSlashes(base).replace(/\/+$/, '');
    return `${b}/${normalizeSlashes(rel).replace(/^\/+/, '')}`;
  }
}

// Singleton instance
let syncTeXServiceInstance: SyncTeXService | null = null;

export function getSyncTeXService(): SyncTeXService {
  if (!syncTeXServiceInstance) {
    syncTeXServiceInstance = new SyncTeXService();
  }
  return syncTeXServiceInstance;
}
