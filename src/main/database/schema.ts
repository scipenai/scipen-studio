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

// ============ AI Chat Sessions ============

export const chatSessionsTable = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  title: text('title'),
  model: text('model'),
  provider: text('provider'),
  systemPrompt: text('system_prompt'),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ AI Chat Messages ============

export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessionsTable.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  model: text('model'),
  tokenCount: integer('token_count'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Project Bindings (Cloud Collaboration) ============

export const projectBindingsTable = sqliteTable('project_bindings', {
  /** Local auto-generated row id */
  id: text('id').primaryKey(),
  /** Cloud OT/remote project id */
  projectId: text('project_id').notNull(),
  /** Collaboration backend kind */
  backend: text('backend', { enum: ['scipen-ot', 'overleaf'] })
    .notNull()
    .default('scipen-ot'),
  /** Authority of the project state */
  authority: text('authority').notNull().default('remote'),
  /** Local materialization mode */
  materialization: text('materialization').notNull().default('local-working-copy'),
  /** Cloud workspace id */
  workspaceId: text('workspace_id').notNull(),
  /** Absolute path to local project root */
  localRootPath: text('local_root_path').notNull().unique(),
  /** Project display name */
  projectName: text('project_name').notNull(),
  /** Last successful sync timestamp */
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  /** Whether sync is currently enabled */
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  /** Custom ignore patterns (JSON string[]) */
  customIgnorePatterns: text('custom_ignore_patterns', { mode: 'json' }).$type<string[]>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Sync File Snapshots (baseline for change detection) ============

export const syncFileSnapshotsTable = sqliteTable('sync_file_snapshots', {
  id: text('id').primaryKey(),
  /** References project_bindings.project_id */
  projectId: text('project_id').notNull(),
  /** Relative file path (forward slashes) */
  filePath: text('file_path').notNull(),
  /** OT file id (null for resource files) */
  fileId: text('file_id'),
  /** File category */
  fileType: text('file_type', { enum: ['ot_text', 'resource'] }).notNull(),
  /** Content hash at last sync (MD5 hex, 8 chars) */
  contentHash: text('content_hash').notNull(),
  /** File size in bytes */
  fileSize: integer('file_size').notNull(),
  /** OT version at last sync (null for resource files) */
  otVersion: integer('ot_version'),
  /** Timestamp of last successful sync */
  syncedAt: integer('synced_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Pending Offline OT Operations ============

export const pendingOpsTable = sqliteTable('pending_ops', {
  id: text('id').primaryKey(),
  /** Cloud OT project id */
  projectId: text('project_id').notNull(),
  /** OT file id */
  fileId: text('file_id').notNull(),
  /** OT version this operation is based on */
  baseVersion: integer('base_version').notNull(),
  /** Serialized OT operations (JSON array of RawOp) */
  ops: text('ops', { mode: 'json' }).notNull(),
  /** Content hash after applying the operation locally */
  localContentHash: text('local_content_hash').notNull(),
  /** When this operation was created */
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Assistant Conversation Bindings ============

export const assistantConversationBindingsTable = sqliteTable('assistant_conversation_bindings', {
  id: text('id').primaryKey(),
  runtime: text('runtime').notNull(),
  conversationId: text('conversation_id').notNull().unique(),
  scopeType: text('scope_type').notNull(),
  scopeKey: text('scope_key').notNull(),
  projectId: text('project_id'),
  localRootPath: text('local_root_path'),
  workspaceId: text('workspace_id'),
  title: text('title'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false).notNull(),
  lastOpenedAt: integer('last_opened_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ User Settings ============

export const userSettingsTable = sqliteTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Type Exports ============

export type Project = typeof projectsTable.$inferSelect;
export type NewProject = typeof projectsTable.$inferInsert;

export type ChatSession = typeof chatSessionsTable.$inferSelect;
export type NewChatSession = typeof chatSessionsTable.$inferInsert;

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type NewChatMessage = typeof chatMessagesTable.$inferInsert;

export type UserSetting = typeof userSettingsTable.$inferSelect;
export type NewUserSetting = typeof userSettingsTable.$inferInsert;

export type ProjectBinding = typeof projectBindingsTable.$inferSelect;
export type NewProjectBinding = typeof projectBindingsTable.$inferInsert;

export type SyncFileSnapshot = typeof syncFileSnapshotsTable.$inferSelect;
export type NewSyncFileSnapshot = typeof syncFileSnapshotsTable.$inferInsert;

export type PendingOp = typeof pendingOpsTable.$inferSelect;
export type NewPendingOp = typeof pendingOpsTable.$inferInsert;

export type AssistantConversationBinding = typeof assistantConversationBindingsTable.$inferSelect;
export type NewAssistantConversationBinding =
  typeof assistantConversationBindingsTable.$inferInsert;
