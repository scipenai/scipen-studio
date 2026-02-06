/**
 * @file Database Schema - Drizzle ORM Table Definitions
 * @description Defines core table structures for projects, knowledge base, documents, vectors, chat, settings
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

// ============ Knowledge Libraries ============

export const knowledgeLibrariesTable = sqliteTable('knowledge_libraries', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  embeddingModel: text('embedding_model').default('text-embedding-3-small'),
  embeddingDimensions: integer('embedding_dimensions').default(1536),
  chunkSize: integer('chunk_size').default(512),
  chunkOverlap: integer('chunk_overlap').default(50),
  retrievalConfig: text('retrieval_config', { mode: 'json' }).$type<Record<string, unknown>>(),
  documentCount: integer('document_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Knowledge Documents ============

export const knowledgeDocumentsTable = sqliteTable('knowledge_documents', {
  id: text('id').primaryKey(),
  libraryId: text('library_id')
    .notNull()
    .references(() => knowledgeLibrariesTable.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  filePath: text('file_path'),
  originalName: text('original_name'),
  mediaType: text('media_type').notNull().default('text/plain'),
  fileSize: integer('file_size'),
  contentHash: text('content_hash'),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'error'] }).default(
    'pending'
  ),
  errorMessage: text('error_message'),
  bibKey: text('bib_key'),
  citationText: text('citation_text'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
});

// ============ Knowledge Chunks ============

export const knowledgeChunksTable = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id')
    .notNull()
    .references(() => knowledgeDocumentsTable.id, { onDelete: 'cascade' }),
  libraryId: text('library_id')
    .notNull()
    .references(() => knowledgeLibrariesTable.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  startOffset: integer('start_offset'),
  endOffset: integer('end_offset'),
  pageNumber: integer('page_number'),
  sectionTitle: text('section_title'),
  hasEmbedding: integer('has_embedding', { mode: 'boolean' }).default(false),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Vector Embeddings ============
// Note: Actual embeddings are stored in HNSW index for performance
// This table tracks embedding metadata

export const embeddingsMetaTable = sqliteTable('embeddings_meta', {
  chunkId: text('chunk_id')
    .primaryKey()
    .references(() => knowledgeChunksTable.id, { onDelete: 'cascade' }),
  libraryId: text('library_id')
    .notNull()
    .references(() => knowledgeLibrariesTable.id, { onDelete: 'cascade' }),
  embeddingModel: text('embedding_model').notNull(),
  dimensions: integer('dimensions').notNull(),
  hnswIndex: integer('hnsw_index'),
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

// ============ User Settings ============

export const userSettingsTable = sqliteTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ============ Type Exports ============

export type Project = typeof projectsTable.$inferSelect;
export type NewProject = typeof projectsTable.$inferInsert;

export type KnowledgeLibrary = typeof knowledgeLibrariesTable.$inferSelect;
export type NewKnowledgeLibrary = typeof knowledgeLibrariesTable.$inferInsert;

export type KnowledgeDocument = typeof knowledgeDocumentsTable.$inferSelect;
export type NewKnowledgeDocument = typeof knowledgeDocumentsTable.$inferInsert;

export type KnowledgeChunk = typeof knowledgeChunksTable.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunksTable.$inferInsert;

export type EmbeddingMeta = typeof embeddingsMetaTable.$inferSelect;
export type NewEmbeddingMeta = typeof embeddingsMetaTable.$inferInsert;

export type ChatSession = typeof chatSessionsTable.$inferSelect;
export type NewChatSession = typeof chatSessionsTable.$inferInsert;

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type NewChatMessage = typeof chatMessagesTable.$inferInsert;

export type UserSetting = typeof userSettingsTable.$inferSelect;
export type NewUserSetting = typeof userSettingsTable.$inferInsert;
