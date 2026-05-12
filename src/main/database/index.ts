/**
 * @file Database Connection Manager
 * @description Provides Drizzle ORM SQLite connection with WAL mode support
 * @depends better-sqlite3, drizzle-orm, schema
 */

import path from 'path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import { createLogger } from '../services/LoggerService';
import fs from 'fs-extra';
import * as schema from './schema';

const logger = createLogger('Database');

let db: BetterSQLite3Database<typeof schema> | null = null;
let sqliteDb: Database.Database | null = null;

function ensureCoreTables(rawDb: Database.Database): void {
  const tables = rawDb
    .prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `)
    .all() as { name: string }[];

  const tableNames = new Set(tables.map((t) => t.name));

  if (!tableNames.has('project_bindings')) {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS project_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'scipen-ot',
        authority TEXT NOT NULL DEFAULT 'remote',
        materialization TEXT NOT NULL DEFAULT 'local-working-copy',
        workspace_id TEXT NOT NULL,
        local_root_path TEXT NOT NULL UNIQUE,
        project_name TEXT NOT NULL,
        last_sync_at INTEGER,
        enabled INTEGER DEFAULT 1,
        custom_ignore_patterns TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    logger.info('[Database] Created project_bindings table');
  } else {
    const columns = rawDb.prepare('PRAGMA table_info(project_bindings)').all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('backend')) {
      rawDb.exec(
        `ALTER TABLE project_bindings ADD COLUMN backend TEXT NOT NULL DEFAULT 'scipen-ot'`
      );
    }
    if (!columnNames.has('authority')) {
      rawDb.exec(
        `ALTER TABLE project_bindings ADD COLUMN authority TEXT NOT NULL DEFAULT 'remote'`
      );
    }
    if (!columnNames.has('materialization')) {
      rawDb.exec(
        `ALTER TABLE project_bindings ADD COLUMN materialization TEXT NOT NULL DEFAULT 'local-working-copy'`
      );
    }
  }

  if (!tableNames.has('sync_file_snapshots')) {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_file_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_id TEXT,
        file_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        ot_version INTEGER,
        synced_at INTEGER DEFAULT (unixepoch())
      )
    `);
    rawDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_snapshots_project
      ON sync_file_snapshots(project_id)
    `);
    logger.info('[Database] Created sync_file_snapshots table');
  }

  if (!tableNames.has('pending_ops')) {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS pending_ops (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        ops TEXT NOT NULL,
        local_content_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    rawDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_ops_file
      ON pending_ops(project_id, file_id)
    `);
    logger.info('[Database] Created pending_ops table');
  }

  if (!tableNames.has('assistant_conversation_bindings')) {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS assistant_conversation_bindings (
        id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        project_id TEXT,
        local_root_path TEXT,
        workspace_id TEXT,
        title TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    rawDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_assistant_conversations_scope
      ON assistant_conversation_bindings(runtime, scope_type, scope_key)
    `);
    rawDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_assistant_conversations_project
      ON assistant_conversation_bindings(project_id)
    `);
    logger.info('[Database] Created assistant_conversation_bindings table');
  }
}

/**
 * Get the database file path
 */
export function getDatabasePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'scipen-studio.db');
}

/**
 * Initialize and get the database connection
 */
export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (db) {
    return db;
  }

  const dbPath = getDatabasePath();

  // Ensure directory exists
  fs.ensureDirSync(path.dirname(dbPath));

  // Create SQLite connection
  sqliteDb = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Create Drizzle instance
  db = drizzle(sqliteDb, { schema });

  logger.info('[Database] Initialized at:', dbPath);

  return db;
}

/**
 * Get the raw SQLite database instance
 * Useful for operations not supported by Drizzle
 */
export function getRawDatabase(): Database.Database {
  if (!sqliteDb) {
    getDatabase(); // Initialize if not already
  }
  return sqliteDb!;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    db = null;
    logger.info('[Database] Connection closed');
  }
}

/**
 * Run database migrations
 * Note: In production, use drizzle-kit for migrations
 */
export async function runMigrations(): Promise<void> {
  // Ensure database is initialized
  getDatabase();

  // For development, we can use push or manual SQL
  // In production, use generated migrations from drizzle-kit
  logger.info('[Database] Migrations would run here in production');

  // Create tables if they don't exist (development only)
  const rawDb = getRawDatabase();

  const tables = rawDb
    .prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `)
    .all() as { name: string }[];

  if (tables.length === 0) {
    logger.info('[Database] No tables found, schema will be created by drizzle-kit push');
  } else {
    logger.info('[Database] Existing tables:', tables.map((t) => t.name).join(', '));
  }

  ensureCoreTables(rawDb);
}

// Export schema for use in other modules
export * from './schema';
