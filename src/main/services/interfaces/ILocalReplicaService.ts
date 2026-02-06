/**
 * @file ILocalReplicaService - Local Replica Sync Service Interface
 * @description Defines the contract for bidirectional sync between Overleaf projects and local directories
 * @depends IDisposable
 */

import type { IDisposable } from '../ServiceContainer';

// ====== Configuration Types ======

/** Local Replica configuration. */
export interface LocalReplicaConfig {
  /** Remote project id. */
  projectId: string;
  /** Project name. */
  projectName: string;
  /** Local sync directory path. */
  localPath: string;
  /** Whether auto sync is enabled. */
  enabled: boolean;
  /** Custom ignore patterns (appended to defaults). */
  customIgnorePatterns?: string[];
}

// ====== Sync Result Types ======

/** Sync result. */
export interface SyncResult {
  /** Count of successfully synced files. */
  synced: number;
  /** Count of skipped files (ignore rules). */
  skipped: number;
  /** Error messages. */
  errors: string[];
  /** Conflicting file paths. */
  conflicts: string[];
}

/** Sync progress event. */
export interface SyncProgressEvent {
  /** Progress percentage (0-100). */
  progress: number;
  /** Current file path being processed. */
  currentFile?: string;
  /** Status message. */
  message: string;
}

/** Conflict info. */
export interface ConflictInfo {
  /** Relative file path. */
  path: string;
  /** Local content hash. */
  localHash: string;
  /** Remote content hash. */
  remoteHash: string;
  /** Local modified time. */
  localMtime: number;
  /** Remote modified time. */
  remoteMtime?: number;
}

// ====== Service Interface ======

/**
 * Local Replica service interface.
 */
export interface ILocalReplicaService extends IDisposable {
  // ====== Initialization & Configuration ======

  /**
   * Initializes Local Replica.
   * @param config Configuration
   * @returns Whether initialization succeeded
   */
  init(config: LocalReplicaConfig): Promise<boolean>;

  /**
   * Returns current configuration.
   * @returns Config or null when uninitialized
   */
  getConfig(): LocalReplicaConfig | null;

  /**
   * Checks whether sync is enabled.
   */
  isEnabled(): boolean;

  /**
   * Sets enabled state.
   * @param enabled Whether enabled
   */
  setEnabled(enabled: boolean): void;

  // ====== Sync Operations ======

  /**
   * Syncs from remote to local.
   * @sideeffect Writes files to local directory
   */
  syncFromRemote(): Promise<SyncResult>;

  /**
   * Syncs from local to remote.
   * @sideeffect Uploads files to remote project
   */
  syncToRemote(): Promise<SyncResult>;

  // ====== Watching (Phase 3) ======

  /**
   * Starts bidirectional watching (Phase 3).
   * @sideeffect Subscribes to local watcher and remote socket events
   */
  startWatching(): void;

  /**
   * Stops bidirectional watching.
   */
  stopWatching(): void;

  /**
   * Checks whether watching is active.
   */
  isWatching(): boolean;

  // ====== Events ======

  /**
   * Sync progress event.
   * @param event Event name
   * @param listener Listener callback
   */
  on(event: 'sync:progress', listener: (data: SyncProgressEvent) => void): this;

  /**
   * Sync completed event.
   * @param event Event name
   * @param listener Listener callback
   */
  on(event: 'sync:completed', listener: (result: SyncResult) => void): this;

  /**
   * Sync error event.
   * @param event Event name
   * @param listener Listener callback
   */
  on(event: 'sync:error', listener: (error: Error) => void): this;

  /**
   * Sync conflict event.
   * @param event Event name
   * @param listener Listener callback
   */
  on(event: 'sync:conflict', listener: (conflict: ConflictInfo) => void): this;

  /**
   * Removes an event listener.
   */
  off(event: string, listener: (...args: unknown[]) => void): this;
}

// ====== Default Ignore Rules ======

/**
 * Default ignore rules.
 *
 * These core rules are non-overridable; users may only append custom rules.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  // Hidden files and directories
  '**/.*',
  '**/.*/**',

  // LaTeX build artifacts
  '**/*.aux',
  '**/*.bbl',
  '**/*.bcf',
  '**/*.blg',
  '**/*.fdb_latexmk',
  '**/*.fls',
  '**/*.git',
  '**/*.lof',
  '**/*.log',
  '**/*.lot',
  '**/*.out',
  '**/*.run.xml',
  '**/*.synctex(busy)',
  '**/*.synctex.gz',
  '**/*.toc',
  '**/*.xdv',
  '**/main.pdf',
  '**/output.pdf',
];
