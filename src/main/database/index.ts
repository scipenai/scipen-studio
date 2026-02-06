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
import fs from '../services/knowledge/utils/fsCompat';
import * as schema from './schema';

const logger = createLogger('Database');

let db: BetterSQLite3Database<typeof schema> | null = null;
let sqliteDb: Database.Database | null = null;

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

  // Check if tables exist
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
}

// Export schema for use in other modules
export * from './schema';
