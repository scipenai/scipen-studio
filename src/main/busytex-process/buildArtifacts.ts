/**
 * @file busytex-process/buildArtifacts.ts — what counts as a build artifact
 *
 * Two consumers share one definition so they can never disagree:
 *   - the pass policy fingerprints artifacts to decide whether TeX converged;
 *   - the incremental cache carries artifacts into the next compile.
 *
 * Membership is a BLOCKLIST, not an allow-list: everything TeX leaves in the
 * project dir that is not a staged source and not a pure output counts. An
 * allow-list (.aux/.toc/...) silently drops `.lol`, `.loa`, `.ptc`, `.tdo`,
 * `.brf` and user-defined float lists, which then come out empty with no
 * error.
 *
 * Loaded by the bundled engine host AND directly by Node (scripts/bench via
 * type stripping): node builtins only, erasable TS syntax only, no relative
 * imports.
 */

import { createHash } from 'node:crypto';

/** Minimal slice of the emscripten FS API this module touches. */
export interface ArtifactFs {
  analyzePath(path: string): { exists: boolean };
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  readFile(path: string, opts: { encoding: 'binary' }): Uint8Array;
}

export interface Artifact {
  /** Project-relative, `/`-separated. */
  path: string;
  bytes: Uint8Array;
}

/** Caps keep a pathological document from bloating every later compile. */
export const ARTIFACT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Written for humans or for the next tool in the chain, never read back by TeX. */
const OUTPUT_ONLY = new Set(['log', 'xdv', 'dvi', 'pdf', 'blg', 'ilg', 'fls', 'fdb_latexmk']);
/**
 * Rewritten from scratch by every pass and consumed by a post-processor.
 * Carrying an old `.idx` would make makeindex run (and emit a stale `.ind`)
 * even after `\makeindex` is removed from the document.
 */
const PER_PASS_INPUT = new Set(['idx', 'glo']);
/** Source-like files: never artifacts, even when a filecontents env writes one. */
const SOURCE_LIKE = new Set([
  'tex',
  'sty',
  'cls',
  'bib',
  'bst',
  'def',
  'cfg',
  'fd',
  'clo',
  'ldf',
  'ltx',
  'dtx',
  'ins',
]);
/** Figures are staged sources; hashing them every pass would cost tens of MB. */
const IMAGE_LIKE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'eps', 'svg', 'tif', 'tiff']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** True when a file at this project-relative path may be carried as an artifact. */
export function isArtifactPath(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  // SyncTeX writes `x.synctex.gz`, and `x.synctex(busy)` while in flight.
  if (lower.includes('.synctex')) return false;
  const ext = extensionOf(lower);
  if (!ext) return false;
  return (
    !OUTPUT_ONLY.has(ext) &&
    !PER_PASS_INPUT.has(ext) &&
    !SOURCE_LIKE.has(ext) &&
    !IMAGE_LIKE.has(ext)
  );
}

/**
 * Collect every artifact under `root`. `sourcePaths` are the files staged as
 * real sources for this compile — they are inputs, not products, even when
 * their extension would qualify (a committed `.bbl`, say). Files over the
 * per-file cap are skipped; collection stops at the total cap.
 */
export function listArtifacts(
  fs: ArtifactFs,
  root: string,
  sourcePaths: ReadonlySet<string>
): Artifact[] {
  const out: Artifact[] = [];
  let total = 0;
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdir(dir).sort()) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.stat(full);
      if (fs.isDir(st.mode)) {
        walk(full, relPath);
        continue;
      }
      if (!fs.isFile(st.mode) || sourcePaths.has(relPath) || !isArtifactPath(relPath)) continue;
      if (st.size > ARTIFACT_MAX_FILE_BYTES) continue;
      if (total + st.size > ARTIFACT_MAX_TOTAL_BYTES) return;
      total += st.size;
      out.push({ path: relPath, bytes: fs.readFile(full, { encoding: 'binary' }) });
    }
  };
  if (fs.analyzePath(root).exists) walk(root.replace(/\/+$/, ''), '');
  return out;
}

/**
 * Content fingerprint of the artifact set. Equal fingerprints across a pass
 * mean TeX reached a fixed point — the same signal latexmk uses, without
 * grepping log text for package-specific phrases.
 */
export function fingerprintArtifacts(
  fs: ArtifactFs,
  root: string,
  sourcePaths: ReadonlySet<string>
): string {
  const hash = createHash('sha1');
  for (const { path, bytes } of listArtifacts(fs, root, sourcePaths)) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
