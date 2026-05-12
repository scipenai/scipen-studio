/**
 * @file ConversationBindingStore.ts — local SQLite storage layer.
 * @description CRUD for the assistant_conversation_bindings table.
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import type {
  ProjectConversationBindingDTO,
  ProjectConversationRuntime,
} from '../../../../shared/api-types';
import { assistantConversationBindingsTable, getDatabase } from '../../database';

type ScopeType = 'global' | 'project';
type ConversationRuntime = ProjectConversationRuntime;
type BindingRow = typeof assistantConversationBindingsTable.$inferSelect;

// ====== Helpers ======

export function normalizeLocalRootPath(localRootPath?: string | null): string | null {
  if (!localRootPath) return null;
  return path.normalize(localRootPath);
}

export function normalizeWorkspaceId(workspaceId?: string | null): string {
  return (workspaceId ?? '').trim();
}

export function toDto(row: BindingRow): ProjectConversationBindingDTO {
  return {
    id: row.id,
    runtime: row.runtime as ConversationRuntime,
    conversationId: row.conversationId,
    scopeType: row.scopeType as ScopeType,
    scopeKey: row.scopeKey,
    projectId: row.projectId ?? null,
    localRootPath: row.localRootPath ?? null,
    workspaceId: row.workspaceId ?? null,
    title: row.title ?? null,
    isDefault: Boolean(row.isDefault),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt ?? Date.now()),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt ?? Date.now()),
    lastOpenedAt:
      row.lastOpenedAt instanceof Date
        ? row.lastOpenedAt.getTime()
        : row.lastOpenedAt == null
          ? null
          : Number(row.lastOpenedAt),
  };
}

export function buildScopeKey(
  scopeType: ScopeType,
  projectId?: string | null,
  localRootPath?: string | null
): string {
  if (scopeType === 'global') return 'global';
  if (projectId?.trim()) return `project:${projectId.trim()}`;
  const normalizedRoot = normalizeLocalRootPath(localRootPath);
  if (!normalizedRoot) {
    throw new Error('Missing projectId/localRootPath for project-scoped conversation');
  }
  return `path:${normalizedRoot}`;
}

export function resolveTitle(
  scopeType: ScopeType,
  title?: string | null,
  projectId?: string | null,
  localRootPath?: string | null
): string {
  if (title?.trim()) return title.trim();
  if (scopeType === 'global') return 'SciPen Global';
  if (localRootPath) return path.basename(localRootPath) || 'SciPen Project';
  if (projectId) return `Project ${projectId}`;
  return 'SciPen Project';
}

// ====== Store ======

interface ScopeQuery {
  runtime: ConversationRuntime;
  scopeType: ScopeType;
  projectId?: string | null;
  localRootPath?: string | null;
  workspaceId?: string | null;
}

export class ConversationBindingStore {
  async findBest(params: ScopeQuery): Promise<BindingRow | null> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(assistantConversationBindingsTable)
      .where(this.buildWhereClause(params))
      .orderBy(
        desc(assistantConversationBindingsTable.isDefault),
        desc(assistantConversationBindingsTable.lastOpenedAt),
        desc(assistantConversationBindingsTable.updatedAt)
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<BindingRow | null> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(assistantConversationBindingsTable)
      .where(eq(assistantConversationBindingsTable.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(params: ScopeQuery): Promise<ProjectConversationBindingDTO[]> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(assistantConversationBindingsTable)
      .where(this.buildWhereClause(params))
      .orderBy(
        desc(assistantConversationBindingsTable.isDefault),
        desc(assistantConversationBindingsTable.lastOpenedAt),
        desc(assistantConversationBindingsTable.updatedAt)
      );
    return rows.map(toDto);
  }

  async insert(values: {
    conversationId: string;
    runtime: ConversationRuntime;
    scopeType: ScopeType;
    scopeKey: string;
    projectId: string | null;
    localRootPath: string | null;
    workspaceId: string | null;
    title: string;
    isDefault: boolean;
  }): Promise<ProjectConversationBindingDTO> {
    const db = getDatabase();
    const now = new Date();
    const id = randomUUID();
    await db.insert(assistantConversationBindingsTable).values({
      id,
      ...values,
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.findById(id);
    if (!created) throw new Error('Failed to create local conversation binding');
    return toDto(created);
  }

  async touch(
    binding: BindingRow,
    updates: {
      projectId?: string | null;
      localRootPath?: string | null;
      workspaceId?: string | null;
      title?: string | null;
    }
  ): Promise<void> {
    const db = getDatabase();
    const nextProjectId = updates.projectId ?? binding.projectId ?? null;
    const nextLocalRootPath =
      normalizeLocalRootPath(updates.localRootPath) ?? binding.localRootPath ?? null;
    const nextWorkspaceId =
      normalizeWorkspaceId(updates.workspaceId) ||
      normalizeWorkspaceId(binding.workspaceId ?? null);
    const nextScopeKey = buildScopeKey(
      binding.scopeType as ScopeType,
      nextProjectId,
      nextLocalRootPath
    );

    await db
      .update(assistantConversationBindingsTable)
      .set({
        projectId: nextProjectId,
        localRootPath: nextLocalRootPath,
        workspaceId: nextWorkspaceId,
        title: updates.title ?? binding.title,
        scopeKey: nextScopeKey,
        lastOpenedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(assistantConversationBindingsTable.id, binding.id));
  }

  async setDefault(bindingId: string): Promise<void> {
    const binding = await this.findById(bindingId);
    if (!binding) throw new Error(`Conversation binding not found: ${bindingId}`);

    await this.clearDefaults(
      binding.runtime as ConversationRuntime,
      binding.scopeType as ScopeType,
      binding.projectId ?? null,
      binding.localRootPath ?? null,
      binding.workspaceId ?? null
    );

    const db = getDatabase();
    await db
      .update(assistantConversationBindingsTable)
      .set({ isDefault: true, lastOpenedAt: new Date(), updatedAt: new Date() })
      .where(eq(assistantConversationBindingsTable.id, bindingId));
  }

  async deleteByConversationId(conversationId: string): Promise<BindingRow | null> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(assistantConversationBindingsTable)
      .where(eq(assistantConversationBindingsTable.conversationId, conversationId))
      .limit(1);
    if (rows.length === 0) return null;
    await db
      .delete(assistantConversationBindingsTable)
      .where(eq(assistantConversationBindingsTable.conversationId, conversationId));
    return rows[0];
  }

  async clearDefaults(
    runtime: ConversationRuntime,
    scopeType: ScopeType,
    projectId: string | null,
    localRootPath: string | null,
    workspaceId: string | null
  ): Promise<void> {
    const db = getDatabase();
    const predicates = [
      eq(assistantConversationBindingsTable.runtime, runtime),
      eq(assistantConversationBindingsTable.scopeType, scopeType),
      eq(assistantConversationBindingsTable.workspaceId, normalizeWorkspaceId(workspaceId)),
    ];

    if (scopeType === 'global') {
      predicates.push(eq(assistantConversationBindingsTable.scopeKey, 'global'));
    } else {
      const alternates = [];
      if (projectId) {
        alternates.push(eq(assistantConversationBindingsTable.projectId, projectId));
      }
      const normalizedRoot = normalizeLocalRootPath(localRootPath);
      if (normalizedRoot) {
        alternates.push(eq(assistantConversationBindingsTable.localRootPath, normalizedRoot));
      }
      if (alternates.length > 0) {
        predicates.push(alternates.length === 1 ? alternates[0] : or(...alternates)!);
      }
    }

    await db
      .update(assistantConversationBindingsTable)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(...predicates));
  }

  private buildWhereClause(params: ScopeQuery) {
    const predicates = [
      eq(assistantConversationBindingsTable.runtime, params.runtime),
      eq(assistantConversationBindingsTable.scopeType, params.scopeType),
      eq(assistantConversationBindingsTable.workspaceId, normalizeWorkspaceId(params.workspaceId)),
    ];

    if (params.scopeType === 'global') {
      predicates.push(eq(assistantConversationBindingsTable.scopeKey, 'global'));
      return and(...predicates)!;
    }

    const alternates = [];
    if (params.projectId) {
      alternates.push(eq(assistantConversationBindingsTable.projectId, params.projectId));
    }
    const normalizedRoot = normalizeLocalRootPath(params.localRootPath);
    if (normalizedRoot) {
      alternates.push(eq(assistantConversationBindingsTable.localRootPath, normalizedRoot));
    }

    if (alternates.length === 0) {
      throw new Error('Project conversation scope requires projectId or localRootPath');
    }

    return and(...predicates, alternates.length === 1 ? alternates[0] : or(...alternates)!)!;
  }
}
