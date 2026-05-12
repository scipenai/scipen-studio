/**
 * @file OfflineOpsStore - Offline OT operation persistence
 * @description Persists uncommitted OT operations to SQLite so a crash does not lose them.
 *   On restart entries are restored from the database, transformed, and resubmitted on reconnect.
 *
 * @depends database, StudioOTService
 */

import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, pendingOpsTable } from '../database';
import type { StudioOTRawOp } from '../../../shared/api-types';
import { createLogger } from './LoggerService';
import type { IDisposable } from './ServiceContainer';

const logger = createLogger('OfflineOpsStore');

// ====== Types ======

export interface PendingOperation {
  id: string;
  projectId: string;
  fileId: string;
  baseVersion: number;
  ops: StudioOTRawOp[];
  localContentHash: string;
  createdAt: Date;
}

export interface ReplayResult {
  success: boolean;
  /** Number of operations replayed successfully */
  replayed: number;
  /** Files that require user intervention */
  conflicts: Array<{ fileId: string; reason: string }>;
}

// ====== Service implementation ======

export class OfflineOpsStore implements IDisposable {
  /**
   * Persists a single offline OT operation. Called when editing occurs in Studio while the
   * network is disconnected.
   */
  async save(
    projectId: string,
    fileId: string,
    baseVersion: number,
    ops: StudioOTRawOp[],
    localContentHash: string
  ): Promise<string> {
    const id = uuidv4();
    const db = getDatabase();

    await db.insert(pendingOpsTable).values({
      id,
      projectId,
      fileId,
      baseVersion,
      ops: ops as unknown as never,
      localContentHash,
    });

    logger.info(`Offline ops persisted: ${fileId} v${baseVersion} (${ops.length} ops)`);
    return id;
  }

  /**
   * Returns every pending operation for a file, ordered by creation time.
   */
  async getByFile(projectId: string, fileId: string): Promise<PendingOperation[]> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(pendingOpsTable)
      .where(and(eq(pendingOpsTable.projectId, projectId), eq(pendingOpsTable.fileId, fileId)))
      .orderBy(pendingOpsTable.createdAt);

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fileId: row.fileId,
      baseVersion: row.baseVersion,
      ops: row.ops as unknown as StudioOTRawOp[],
      localContentHash: row.localContentHash,
      createdAt: row.createdAt ?? new Date(),
    }));
  }

  /**
   * Returns every pending operation for a project.
   */
  async getByProject(projectId: string): Promise<PendingOperation[]> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(pendingOpsTable)
      .where(eq(pendingOpsTable.projectId, projectId))
      .orderBy(pendingOpsTable.createdAt);

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fileId: row.fileId,
      baseVersion: row.baseVersion,
      ops: row.ops as unknown as StudioOTRawOp[],
      localContentHash: row.localContentHash,
      createdAt: row.createdAt ?? new Date(),
    }));
  }

  /**
   * Removes an operation that has been successfully committed.
   */
  async remove(id: string): Promise<void> {
    const db = getDatabase();
    await db.delete(pendingOpsTable).where(eq(pendingOpsTable.id, id));
  }

  /**
   * Clears every pending operation for a file (used during conflict recovery).
   */
  async clearByFile(projectId: string, fileId: string): Promise<void> {
    const db = getDatabase();
    await db
      .delete(pendingOpsTable)
      .where(and(eq(pendingOpsTable.projectId, projectId), eq(pendingOpsTable.fileId, fileId)));
  }

  /**
   * Clears every pending operation for a project.
   */
  async clearByProject(projectId: string): Promise<void> {
    const db = getDatabase();
    await db.delete(pendingOpsTable).where(eq(pendingOpsTable.projectId, projectId));
  }

  /**
   * Returns whether any pending operations exist for a project.
   */
  async hasPending(projectId: string): Promise<boolean> {
    const ops = await this.getByProject(projectId);
    return ops.length > 0;
  }

  dispose(): void {
    // no-op, database connection managed by database module
  }
}
