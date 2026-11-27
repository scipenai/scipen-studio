/**
 * @file busytex-process/projectStager.ts — builds a compile's input set from disk
 *
 * Staging used to happen in the renderer: it read every source and figure
 * back over IPC, base64-encoded the figures, and shipped ~80 MB through main
 * into this process on every compile (and hit the IPC schema's 2000-file cap
 * on figure-heavy projects). The engine process can read the project itself,
 * so the renderer now sends only the unsaved editor buffer.
 *
 * Rules carried over from the renderer: same ignore list, same source and
 * figure extensions, same figure caps. Changed on purpose:
 *   - `.aux` is no longer staged — it is a build artifact, and a stale one
 *     left by a local latexmk run only misleads the first pass (the
 *     incremental cache supplies the engine's own);
 *   - the compile's own output `{outputDir}/{baseName}.pdf` is not staged as
 *     a figure;
 *   - sources are no longer filtered by "sensitive" file names — only TeX
 *     and image extensions are read, and only inside the project root.
 */

import fs from 'node:fs';
import * as nodePath from 'node:path';

/** Read as UTF-8 strings: upstream's bibtex and package resolvers only inspect strings. */
const TEXT_EXTENSIONS = /\.(tex|bib|sty|cls|bst|def|cfg|fd|bbl|clo|ldf|ltx|dtx|ins)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|pdf)$/i;
/** Same essentials FileSystemService skips when indexing a project. */
const IGNORED_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

export const STAGE_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImageTotalBytes: 128 * 1024 * 1024,
  /** Bounds the walk if a project root turns out to be a huge tree. */
  maxEntries: 50_000,
  maxDepth: 32,
};

/**
 * A text read within this window of its mtime is not cached: the writer may
 * still be mid-save, and a timestamp that later stays put would pin a torn
 * read forever (git's "racy" rule).
 */
const RACY_WINDOW_MS = 3_000;

export interface StageRequest {
  /** Absent for a file opened outside any project: stage the buffer alone. */
  projectRoot?: string;
  mainFileAbs: string;
  /** The editor buffer, which may hold unsaved changes. */
  overlay: { absPath: string; contents: string };
  outputDir: string;
  baseName: string;
}

export interface StagedFile {
  /** Project-relative, `/`-separated, with the casing found on disk. */
  path: string;
  contents: string | Uint8Array;
}

export interface StageStats {
  entries: number;
  staged: number;
  textReads: number;
  textCacheHits: number;
  imageReads: number;
  imageBytes: number;
  skippedLarge: number;
  skippedBudget: number;
  skippedUnreadable: number;
  /** The walk stopped at maxEntries / maxDepth. */
  truncated: boolean;
  ms: number;
}

export interface StageResult {
  files: StagedFile[];
  /** Staged name of the main file. */
  mainFile: string;
  stats: StageStats;
}

interface CachedText {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  text: string;
}

function sameFile(a: fs.Stats, b: fs.Stats | CachedText): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function statOrNull(abs: string): fs.Stats | null {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

/**
 * Project-relative staged name for `abs`, or null when it lies outside
 * `root`. Case-insensitive where the filesystem is (Windows), so a renderer
 * path whose drive letter or folder casing differs from the disk still maps
 * onto the same staged file.
 */
export function relativeToRoot(
  abs: string,
  root: string,
  caseInsensitive = process.platform === 'win32'
): string | null {
  const file = nodePath.resolve(abs).replace(/\\/g, '/');
  const base = nodePath.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const [f, b] = caseInsensitive ? [file.toLowerCase(), base.toLowerCase()] : [file, base];
  return f.startsWith(`${b}/`) ? file.slice(base.length + 1) : null;
}

export class ProjectStager {
  private cacheRoot: string | null = null;
  /** Text contents keyed by absolute path; images are re-read every time. */
  private readonly textCache = new Map<string, CachedText>();

  constructor(private readonly caseInsensitive = process.platform === 'win32') {}

  stage(request: StageRequest): StageResult {
    const t0 = performance.now();
    const stats: StageStats = {
      entries: 0,
      staged: 0,
      textReads: 0,
      textCacheHits: 0,
      imageReads: 0,
      imageBytes: 0,
      skippedLarge: 0,
      skippedBudget: 0,
      skippedUnreadable: 0,
      truncated: false,
      ms: 0,
    };
    const files = new Map<string, StagedFile>();
    const keyOf = (rel: string): string => (this.caseInsensitive ? rel.toLowerCase() : rel);
    const relOf = (abs: string): string | null =>
      request.projectRoot ? relativeToRoot(abs, request.projectRoot, this.caseInsensitive) : null;

    if (request.projectRoot) {
      if (this.cacheRoot !== request.projectRoot) {
        // One project's sources at a time — keeps the cache bounded.
        this.textCache.clear();
        this.cacheRoot = request.projectRoot;
      }
      const outputPdf = relOf(nodePath.join(request.outputDir, `${request.baseName}.pdf`));
      this.walk(request.projectRoot, files, stats, keyOf, outputPdf ? keyOf(outputPdf) : null);
    }

    // The editor buffer wins over disk; keep the disk casing when both exist.
    const overlayPath =
      relOf(request.overlay.absPath) ?? nodePath.basename(request.overlay.absPath);
    const overlayKey = keyOf(overlayPath);
    files.set(overlayKey, {
      path: files.get(overlayKey)?.path ?? overlayPath,
      contents: request.overlay.contents,
    });

    const mainPath = relOf(request.mainFileAbs) ?? nodePath.basename(request.mainFileAbs);
    const mainFile = files.get(keyOf(mainPath))?.path ?? mainPath;

    stats.staged = files.size;
    stats.ms = Math.round(performance.now() - t0);
    return { files: [...files.values()], mainFile, stats };
  }

  private walk(
    projectRoot: string,
    files: Map<string, StagedFile>,
    stats: StageStats,
    keyOf: (rel: string) => string,
    outputPdfKey: string | null
  ): void {
    let root: string;
    try {
      // Walk from the real directory: an opened root that is itself a link
      // or junction is followed once; links found inside it are skipped.
      root = fs.realpathSync(projectRoot);
    } catch {
      return;
    }
    let imageTotal = 0;
    const visit = (dir: string, rel: string, depth: number): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        stats.skippedUnreadable += 1;
        return;
      }
      for (const entry of entries) {
        if (IGNORED_NAMES.has(entry.name)) continue;
        if (++stats.entries > STAGE_LIMITS.maxEntries) {
          stats.truncated = true;
          return;
        }
        const abs = nodePath.join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        // Dirent reports links (and Windows junctions / reparse points) as
        // neither file nor directory, so they are skipped — the same rule
        // the project file scanner uses, and what keeps the walk inside root.
        if (entry.isDirectory()) {
          if (depth >= STAGE_LIMITS.maxDepth) {
            stats.truncated = true;
            continue;
          }
          visit(abs, childRel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const key = keyOf(childRel);
        if (TEXT_EXTENSIONS.test(entry.name)) {
          const text = this.readText(abs, stats);
          if (text !== null) files.set(key, { path: childRel, contents: text });
        } else if (IMAGE_EXTENSIONS.test(entry.name) && key !== outputPdfKey) {
          const bytes = this.readImage(abs, imageTotal, stats);
          if (bytes) {
            imageTotal += bytes.byteLength;
            files.set(key, { path: childRel, contents: bytes });
          }
        }
      }
    };
    visit(root, '', 0);
  }

  private readText(abs: string, stats: StageStats): string | null {
    const before = statOrNull(abs);
    if (!before) {
      stats.skippedUnreadable += 1;
      return null;
    }
    const cached = this.textCache.get(abs);
    if (cached && sameFile(before, cached)) {
      stats.textCacheHits += 1;
      return cached.text;
    }
    try {
      // stat → read → stat: a size/time change in between means the read may
      // be torn. Retry once; if it is still moving, use it but do not cache.
      let text = fs.readFileSync(abs, 'utf8');
      let after = statOrNull(abs);
      if (!after || !sameFile(before, after)) {
        text = fs.readFileSync(abs, 'utf8');
        const settled = statOrNull(abs);
        if (!after || !settled || !sameFile(after, settled)) {
          stats.textReads += 1;
          this.textCache.delete(abs);
          return text;
        }
        after = settled;
      }
      stats.textReads += 1;
      if (Date.now() - after.mtimeMs >= RACY_WINDOW_MS) {
        this.textCache.set(abs, {
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          ino: after.ino,
          text,
        });
      } else {
        this.textCache.delete(abs);
      }
      return text;
    } catch {
      // EBUSY / EPERM (Windows: file held open by another writer), or gone.
      stats.skippedUnreadable += 1;
      return null;
    }
  }

  private readImage(abs: string, imageTotal: number, stats: StageStats): Uint8Array | null {
    const st = statOrNull(abs);
    if (!st) {
      stats.skippedUnreadable += 1;
      return null;
    }
    if (st.size > STAGE_LIMITS.maxImageBytes) {
      stats.skippedLarge += 1;
      return null;
    }
    if (imageTotal + st.size > STAGE_LIMITS.maxImageTotalBytes) {
      stats.skippedBudget += 1;
      return null;
    }
    try {
      const bytes = fs.readFileSync(abs);
      stats.imageReads += 1;
      stats.imageBytes += bytes.byteLength;
      return bytes;
    } catch {
      stats.skippedUnreadable += 1;
      return null;
    }
  }
}
