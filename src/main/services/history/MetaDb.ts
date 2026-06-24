/**
 * @file MetaDb - SQLite metadata store for the history system.
 *
 * Owns the schema migration runner plus a thin set of helpers (transaction,
 * prepare-and-cache, close). The DB file lives at `{rootDir}/meta.db`. WAL +
 * NORMAL synchronous = sub-ms commit on the keystroke hot path. STRICT tables
 * give us typed columns + INTEGER rowid efficiency.
 *
 * Migrations are an in-source list, not on-disk `.sql` files: it dodges
 * vite/electron-vite asset bundling, keeps the up-to-date schema visible in
 * one read, and stays grep-friendly for callers checking which version owns
 * which column.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../LoggerService';

// vite-node's static analyser doesn't yet recognise the `node:sqlite`
// builtin (Node 22.5+ / Electron 42). Pulling it through `createRequire`
// keeps the import opaque to the bundler so it lands at runtime as a real
// Node builtin instead of triggering "Cannot bundle Node.js built-in".
const _require = createRequire(import.meta.url);
const sqliteModule = _require('node:sqlite') as typeof import('node:sqlite');
const DatabaseSyncCtor = sqliteModule.DatabaseSync;

/**
 * Re-exported alias so consumers (BlobStore / HistoryService) can type
 * statements without importing `node:sqlite` themselves. Keeps the surface
 * dependency on the sqlite implementation centralized here — if we ever swap
 * back to better-sqlite3 or to another driver, only this file changes.
 */
export type SqliteDatabase = DatabaseSync;

const logger = createLogger('MetaDb');

export interface Migration {
  version: number;
  description: string;
  up: string;
}

/**
 * Versioned schema. NEVER edit a past migration in-place — append a new entry.
 * The runner skips applied versions by `MAX(version)` lookup, so renaming or
 * mutating an applied migration would silently corrupt installed DBs.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial history tables',
    up: `
CREATE TABLE history_blob (
  hash       BLOB PRIMARY KEY,
  bytes      BLOB,
  size       INTEGER NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX history_blob_orphan ON history_blob(refcount) WHERE refcount = 0;

CREATE TABLE history_chunk (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  version_from  INTEGER NOT NULL,
  version_to    INTEGER NOT NULL,
  base_blob     BLOB NOT NULL,
  target_blob   BLOB NOT NULL,
  op_count      INTEGER NOT NULL,
  primary_actor TEXT,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX history_chunk_file_version ON history_chunk(file_id, version_to);

CREATE TABLE history_label (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL
) STRICT;

CREATE TABLE history_label_file (
  label_id   TEXT NOT NULL REFERENCES history_label(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  blob_hash  BLOB NOT NULL,
  version    INTEGER NOT NULL,
  PRIMARY KEY (label_id, file_id)
) STRICT;

CREATE TABLE history_session (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  chat_thread_id  TEXT,
  head_step_hash  BLOB,
  parent_session  TEXT REFERENCES history_session(id),
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
) STRICT;

CREATE TABLE history_step (
  hash         BLOB PRIMARY KEY,
  parent_hash  BLOB,
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES history_session(id),
  tree_hash    BLOB NOT NULL,
  causes       BLOB NOT NULL,
  origin       TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  size_delta   INTEGER NOT NULL
) STRICT;

CREATE INDEX history_step_session ON history_step(session_id, ts);

CREATE TABLE history_step_file (
  step_hash BLOB NOT NULL REFERENCES history_step(hash) ON DELETE CASCADE,
  file_id   TEXT NOT NULL,
  blob_hash BLOB NOT NULL,
  PRIMARY KEY (step_hash, file_id)
) STRICT;
`,
  },
];

export interface MetaDbOptions {
  /** Absolute path to the per-project history root (`{...}/history/`). */
  rootDir: string;
}

export class MetaDb {
  readonly db: SqliteDatabase;
  private closed = false;

  constructor(opts: MetaDbOptions) {
    const dbPath = path.join(opts.rootDir, 'meta.db');
    this.db = new DatabaseSyncCtor(dbPath);
    // node:sqlite has no `pragma()` shortcut — run as plain statements.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.bootstrapMigrationTable();
    this.runMigrations();
  }

  private bootstrapMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL
      ) STRICT;
    `);
  }

  /** Apply every migration whose version is above the highest applied version. */
  private runMigrations(): void {
    const applied = (
      this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration').get() as {
        v: number;
      }
    ).v;

    const pending = MIGRATIONS.filter((m) => m.version > applied).sort(
      (a, b) => a.version - b.version
    );
    if (pending.length === 0) return;

    const insertRecord = this.db.prepare(
      'INSERT INTO schema_migration (version, applied_at, description) VALUES (?, ?, ?)'
    );
    // node:sqlite has no `db.transaction(fn)` helper — wrap manually with the
    // standard try/catch + ROLLBACK pattern so a half-applied migration set
    // can never escape.
    this.db.exec('BEGIN');
    try {
      for (const m of pending) {
        this.db.exec(m.up);
        insertRecord.run(m.version, Date.now(), m.description);
        logger.info('applied migration', { version: m.version, description: m.description });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Current highest applied version. Tests assert on this. */
  schemaVersion(): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration').get() as {
        v: number;
      }
    ).v;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createMetaDb(opts: MetaDbOptions): MetaDb {
  return new MetaDb(opts);
}
