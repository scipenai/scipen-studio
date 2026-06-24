/**
 * @file BibTexSyncService — syncs the Zotero canonical index into a
 *   `references.bib` under the project root so LaTeX / Biber / BibTeX builds
 *   can resolve \cite{} entries.
 *
 * @description Data flow (fully automated):
 *
 *   Zotero edit → Orchestrator refresh → ZoteroIndex.applyPatch
 *              → EventBus.emit('bib:patch' / 'bib:initial')
 *              → BibTexSyncService receives the event → debounce 500 ms
 *              → BBT exportBibTex(allCitationKeys, translator)
 *              → hash the output and compare to the last write; if changed:
 *                  a. Has the user hand-edited it? (recorded mtime ≠ current
 *                     mtime)
 *                     → yes → mark conflict, do not overwrite, prompt the UI
 *                     → no  → write new contents, record mtime + hash
 *              → editor build reads references.bib via bibtex/biber as usual
 *
 *   Design trade-offs:
 *   - **Full rewrite**: 5k entries measured at < 100 ms write; simple.
 *     Incremental appending is error-prone.
 *   - **BetterBibLaTeX default translator**: UTF-8 friendly, full modern
 *     fields; user-configurable.
 *   - **mtime + hash dual guards**: mtime alone misjudges (two writes in the
 *     same second); hash alone cannot detect external overwrites; both are
 *     needed for safety.
 *   - **Empty-ck fallback**: if BBT is not installed (degraded) the export
 *     is empty → do not write. Leaving the .bib alone is correct: with no
 *     citation keys there is nothing to write.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { BibTexSyncStatusDTO } from '../../../../shared/types/zotero-events';
import type { BibTexSyncConfigDTO } from '../../../../shared/types/zotero';
import type { BetterBibTexClient } from './BetterBibTexClient';
import { getBetterBibTexClient } from './BetterBibTexClient';
import type { ZoteroEventBus } from './ZoteroEventBus';
import { getZoteroEventBus } from './ZoteroEventBus';
import type { ZoteroIndex } from './ZoteroIndex';
import { getZoteroOrchestrator } from './ZoteroOrchestrator';
import { createLogger } from '../LoggerService';

const logger = createLogger('BibTexSyncService');

const DEFAULT_DEBOUNCE_MS = 500;
/**
 * Default output: `.scipen/zotero_library.bib`. Putting it in a subdirectory
 * isolates IDE-generated files; the filename signals "auto-maintained by
 * Zotero — do not hand-edit". Paired with an auto-maintained `.gitignore`
 * entry: keeps the project root clean, stays out of version control, and
 * does not collide with a user-written `references.bib`.
 */
const DEFAULT_FILE_NAME = '.scipen/zotero_library.bib';
const DEFAULT_TRANSLATOR = 'BetterBibLaTeX';
/** Auto-maintain a project-root .gitignore so generated .scipen/ stays out of VCS. */
const SCIPEN_GITIGNORE_MARKER = '.scipen/';

export type BibTexSyncConfig = BibTexSyncConfigDTO;
export type BibTexSyncStatus = BibTexSyncStatusDTO;

export const DEFAULT_BIBTEX_SYNC_CONFIG: BibTexSyncConfigDTO = {
  enabled: true,
  fileName: DEFAULT_FILE_NAME,
  translator: DEFAULT_TRANSLATOR,
};

export interface BibTexSyncDeps {
  index: ZoteroIndex;
  bbt?: BetterBibTexClient;
  bus?: ZoteroEventBus;
  /** Injectable fs module for testing. Defaults to node:fs/promises. */
  fileIO?: typeof fs;
  /** Debounce duration; tests can shorten it. */
  debounceMs?: number;
}

export class BibTexSyncService {
  private readonly index: ZoteroIndex;
  private readonly bbt: BetterBibTexClient;
  private readonly bus: ZoteroEventBus;
  private readonly fileIO: typeof fs;
  private readonly debounceMs: number;

  private projectPath: string | null = null;
  private config: BibTexSyncConfig = DEFAULT_BIBTEX_SYNC_CONFIG;
  private status: BibTexSyncStatus = { kind: 'idle' };

  /** Hash + mtime of the last successful write; used as the dual guard. */
  private lastWrittenHash: string | null = null;
  private lastWrittenMtimeMs: number | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<BibTexSyncStatus> | null = null;
  private unsubBus: (() => void) | null = null;

  constructor(deps: BibTexSyncDeps) {
    this.index = deps.index;
    this.bbt = deps.bbt ?? getBetterBibTexClient();
    this.bus = deps.bus ?? getZoteroEventBus();
    this.fileIO = deps.fileIO ?? fs;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // ============================================================
  // Public API
  // ============================================================

  /** Start — subscribe to bib events. Re-entrant (further start() is a no-op). */
  start(): void {
    if (this.unsubBus) return;
    this.unsubBus = this.bus.on((event) => {
      if (event.kind === 'bib:initial' || event.kind === 'bib:patch') {
        this.scheduleSync();
      }
    });
    logger.info('BibTexSyncService started');
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
    this.status = { kind: 'idle' };
  }

  /** Update the target path on project switch. null disables auto-sync. */
  setProjectPath(projectPath: string | null): void {
    if (this.projectPath === projectPath) return;
    this.projectPath = projectPath;
    // Project changed: the previously recorded mtime/hash referred to the old
    // project's .bib — reset them. Otherwise switching back would misjudge
    // "user has edited the file".
    this.lastWrittenHash = null;
    this.lastWrittenMtimeMs = null;
    if (projectPath) this.scheduleSync();
  }

  /** Called on config change. Enabling auto-triggers one sync. */
  setConfig(next: Partial<BibTexSyncConfig>): void {
    const prev = this.config;
    this.config = { ...this.config, ...next };
    if (!prev.enabled && this.config.enabled) {
      this.scheduleSync();
    }
    // A fileName change means the old mtime/hash points to the wrong file —
    // reset the guards.
    if (next.fileName && next.fileName !== prev.fileName) {
      this.lastWrittenHash = null;
      this.lastWrittenMtimeMs = null;
      this.scheduleSync();
    }
  }

  getStatus(): BibTexSyncStatus {
    return this.status;
  }

  /** Manually triggered by the user (ignores `enabled`, skips debounce). */
  async syncNow(): Promise<BibTexSyncStatus> {
    return this.runSync({ force: true });
  }

  // ============================================================
  // Internals
  // ============================================================

  private scheduleSync(): void {
    if (!this.config.enabled || !this.projectPath) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSync({ force: false });
    }, this.debounceMs);
  }

  private async runSync(opts: { force: boolean }): Promise<BibTexSyncStatus> {
    if (this.inFlight) return this.inFlight;
    const promise = this.doSync(opts).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  private async doSync(opts: { force: boolean }): Promise<BibTexSyncStatus> {
    if (!opts.force && !this.config.enabled) {
      this.status = { kind: 'idle' };
      return this.status;
    }
    if (!this.projectPath) {
      this.status = { kind: 'error', reason: 'No active project' };
      return this.status;
    }

    this.status = { kind: 'syncing' };

    const citationKeys = this.collectCitationKeys();
    if (citationKeys.length === 0) {
      // No BBT keys at all — writing an empty file is meaningless. Leave the
      // .bib in its current state.
      this.status = { kind: 'idle' };
      return this.status;
    }

    let bib: string;
    try {
      bib = await this.bbt.exportBibTex(citationKeys, this.config.translator);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.status = { kind: 'error', reason: `BBT export failed: ${reason}` };
      return this.status;
    }

    const filePath = path.join(this.projectPath, this.config.fileName);
    const nextHash = sha256(bib);

    // Contents unchanged: skip the disk write entirely.
    if (this.lastWrittenHash === nextHash) {
      const lastSyncedAt = new Date().toISOString();
      this.status = { kind: 'skipped-no-change', filePath, lastSyncedAt };
      return this.status;
    }

    // mtime guard: file exists and mtime differs from our last write → edited externally.
    try {
      const stat = await this.fileIO.stat(filePath);
      if (
        this.lastWrittenMtimeMs !== null &&
        Math.floor(stat.mtimeMs) !== Math.floor(this.lastWrittenMtimeMs)
      ) {
        // But if the current file hash already equals nextHash, the concurrent
        // write happens to match our intended contents — safe to overwrite.
        const currentContent = await this.fileIO.readFile(filePath, 'utf-8');
        if (sha256(currentContent) !== nextHash) {
          this.status = {
            kind: 'conflict',
            filePath,
            reason:
              'External modification detected on references.bib; not overwriting to prevent data loss',
          };
          return this.status;
        }
      }
    } catch (err) {
      // File not found is the expected first-sync path; keep going.
      if (!isFileNotFound(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        this.status = { kind: 'error', reason: `stat failed: ${reason}` };
        return this.status;
      }
    }

    try {
      // The subdirectory may not exist (first use of .scipen/); ensure parent first.
      const dir = path.dirname(filePath);
      await this.ensureDir(dir);
      await this.fileIO.writeFile(filePath, bib, 'utf-8');
      const stat = await this.fileIO.stat(filePath);
      this.lastWrittenHash = nextHash;
      this.lastWrittenMtimeMs = stat.mtimeMs;
      // .gitignore maintenance is decoupled from the write — failures must
      // not affect sync status; warn only, never throw.
      void this.ensureGitignore().catch((err) => logger.warn('ensureGitignore failed', err));
      this.status = {
        kind: 'ok',
        filePath,
        bytesWritten: Buffer.byteLength(bib, 'utf-8'),
        lastSyncedAt: new Date().toISOString(),
      };
      logger.info('BibTeX synced', {
        filePath,
        bytes: this.status.bytesWritten,
        keys: citationKeys.length,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.status = { kind: 'error', reason: `writeFile failed: ${reason}` };
    }
    return this.status;
  }

  /** Recursive mkdir; no-op when already present. Mirrors
   * fs.promises.mkdir({recursive:true}) semantics. */
  private async ensureDir(dir: string): Promise<void> {
    type MkdirFn = (p: string, opts: { recursive: boolean }) => Promise<unknown>;
    const mk = (this.fileIO as { mkdir?: MkdirFn }).mkdir;
    if (typeof mk === 'function') {
      await mk(dir, { recursive: true });
    }
  }

  /**
   * Ensure the project-root .gitignore contains `.scipen/`. Rules:
   *   - File missing            → write a .gitignore containing only this rule
   *   - File present, missing rule → append a line
   *   - Rule already present    → no-op
   *
   * Match heuristic: each line trimmed and compared exactly to `.scipen/` or
   * `.scipen` (the two common forms). Glob variants like `/.scipen/` or
   * `**\/.scipen/` are not recognised — users writing those will be treated
   * as missing the rule and we append a line, producing a formal duplicate
   * (semantically harmless; git ignore lines may repeat). This edge case is
   * accepted because 99% of users write `.scipen/`, and strict matching is
   * the most intuitive policy.
   *
   * Note: this does not force users into git; on non-git repos .gitignore is
   * just a harmless file.
   */
  private async ensureGitignore(): Promise<void> {
    if (!this.projectPath) return;
    const gitignorePath = path.join(this.projectPath, '.gitignore');
    let existing = '';
    try {
      existing = await this.fileIO.readFile(gitignorePath, 'utf-8');
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
    }
    const lines = existing.split(/\r?\n/);
    const already = lines.some(
      (l) => l.trim() === SCIPEN_GITIGNORE_MARKER || l.trim() === '.scipen'
    );
    if (already) return;
    const next =
      existing.length === 0
        ? `${SCIPEN_GITIGNORE_MARKER}\n`
        : `${existing.endsWith('\n') ? existing : `${existing}\n`}${SCIPEN_GITIGNORE_MARKER}\n`;
    await this.fileIO.writeFile(gitignorePath, next, 'utf-8');
  }

  private collectCitationKeys(): string[] {
    const out: string[] = [];
    for (const item of this.index.values()) {
      if (item.citationKey) out.push(item.citationKey);
    }
    return out;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}

let singleton: BibTexSyncService | null = null;

export function getBibTexSyncService(): BibTexSyncService {
  if (!singleton) {
    singleton = new BibTexSyncService({
      index: getZoteroOrchestrator().getIndex(),
    });
  }
  return singleton;
}

/** Tests only. */
export function __resetBibTexSyncSingleton(): void {
  singleton?.stop();
  singleton = null;
}
