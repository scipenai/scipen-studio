/**
 * @file Database Schema - Drizzle ORM Table Definitions
 * @description Defines core table structures for projects, chat, settings
 * @depends drizzle-orm/sqlite-core
 */

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ============ Projects ============

export const projectsTable = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  lastOpened: integer('last_opened', { mode: 'timestamp' }).notNull(),
  isRemote: integer('is_remote', { mode: 'boolean' }).default(false),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// AI chat sessions / messages tables were removed in P4-C — SNACA owns
// conversation persistence in its own per-project SQLite under
// `~/.scipen-studio/.snaca/local/projects/<projectId>/state.sqlite`.

// ============ User Settings ============

export const userSettingsTable = sqliteTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Type Exports ============

export type Project = typeof projectsTable.$inferSelect;
export type NewProject = typeof projectsTable.$inferInsert;

export type UserSetting = typeof userSettingsTable.$inferSelect;
export type NewUserSetting = typeof userSettingsTable.$inferInsert;
