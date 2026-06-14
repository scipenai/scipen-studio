/**
 * @file HistoryService - L1 + L2 history API for scipen-studio.
 *
 * L1: chunk (per-file OT-version range) + label (multi-file named snapshot).
 * L2: step (one SNACA tool turn or one human-edit batch) + session DAG.
 *
 * All multi-row writes are wrapped in better-sqlite3 transactions so a half-
 * applied state can never escape: e.g. createLabel inserts the label row, every
 * label_file row, and bumps each referenced blob's refcount under the same
 * transaction, so a crash mid-call leaves zero pollution.
 *
 * Hashing notes:
 * - tree_hash is the SHA-256 of a canonical JSON of `[{fileId, blobHex}, …]`
 *   sorted by fileId. The same JSON is also stored as a blob so consumers can
 *   pull the file → blob map back without a step_file join.
 * - step.hash is the SHA-256 of a `|`-delimited canonical string over
 *   (parent | tree | session | ts | causes). Pipe-delimited beats JSON because
 *   we never have to debug "did this JSON serializer reorder keys" later.
 *
 * TODO(blake3 / msgpack): when network access returns, swap SHA-256 → BLAKE3
 * (one-line in BlobStore + here) and JSON.stringify(causes) → msgpack for the
 * on-disk `causes` blob.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../LoggerService';
import type { BlobStore } from './BlobStore';
import type {
  CreateLabelInput,
  IHistoryService,
  RecordChunkInput,
  RecordChunkResult,
  RecordStepInput,
} from './interfaces/IHistoryService';
import type { MetaDb } from './MetaDb';
import {
  DEFAULT_HISTORY_CONFIG,
  type Hash,
  type HashHex,
  type HistoryChunk,
  type HistoryConfig,
  type HistoryLabel,
  type HistoryStep,
  type LabelKind,
  type StepOrigin,
} from './types';

const logger = createLogger('HistoryService');

export interface HistoryServiceDeps {
  metaDb: MetaDb;
  blobStore: BlobStore;
  config?: Partial<HistoryConfig>;
}

export class HistoryService implements IHistoryService {
  private readonly config: HistoryConfig;
  private readonly stmts: {
    insertChunk: Database.Statement<unknown[]>;
    listChunks: Database.Statement<unknown[]>;
    insertLabel: Database.Statement<unknown[]>;
    insertLabelFile: Database.Statement<unknown[]>;
    listLabels: Database.Statement<unknown[]>;
    listLabelFiles: Database.Statement<unknown[]>;
    insertStep: Database.Statement<unknown[]>;
    insertStepFile: Database.Statement<unknown[]>;
    getStep: Database.Statement<unknown[]>;
    listSessionSteps: Database.Statement<unknown[]>;
    insertSession: Database.Statement<unknown[]>;
    /** Inline refcount bump used inside transactions; shares cache with BlobStore. */
    incRefBlob: Database.Statement<unknown[]>;
  };

  constructor(private readonly deps: HistoryServiceDeps) {
    this.config = { ...DEFAULT_HISTORY_CONFIG, ...(deps.config ?? {}) };
    void this.config;
    const db = deps.metaDb.db;
    this.stmts = {
      insertChunk: db.prepare<unknown[]>(
        `INSERT INTO history_chunk
         (project_id, file_id, version_from, version_to, base_blob, target_blob, op_count, primary_actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      listChunks: db.prepare<unknown[]>(
        `SELECT id, project_id, file_id, version_from, version_to, base_blob, target_blob, op_count, primary_actor, created_at
         FROM history_chunk WHERE project_id = ? AND file_id = ?
         ORDER BY version_to DESC LIMIT ?`
      ),
      insertLabel: db.prepare<unknown[]>(
        `INSERT INTO history_label
         (id, project_id, name, description, kind, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      insertLabelFile: db.prepare<unknown[]>(
        `INSERT INTO history_label_file (label_id, file_id, blob_hash, version) VALUES (?, ?, ?, ?)`
      ),
      listLabels: db.prepare<unknown[]>(
        `SELECT id, project_id, name, description, kind, created_at, created_by
         FROM history_label WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`
      ),
      listLabelFiles: db.prepare<unknown[]>(
        `SELECT file_id, blob_hash, version FROM history_label_file WHERE label_id = ?`
      ),
      insertStep: db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO history_step
         (hash, parent_hash, project_id, session_id, tree_hash, causes, origin, ts, size_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      insertStepFile: db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO history_step_file (step_hash, file_id, blob_hash) VALUES (?, ?, ?)`
      ),
      getStep: db.prepare<unknown[]>(
        `SELECT hash, parent_hash, project_id, session_id, tree_hash, causes, origin, ts, size_delta
         FROM history_step WHERE hash = ?`
      ),
      listSessionSteps: db.prepare<unknown[]>(
        `SELECT hash, parent_hash, project_id, session_id, tree_hash, causes, origin, ts, size_delta
         FROM history_step WHERE session_id = ?
         ORDER BY ts ASC LIMIT ?`
      ),
      insertSession: db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO history_session
         (id, project_id, chat_thread_id, head_step_hash, parent_session, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      ),
      incRefBlob: db.prepare<unknown[]>(
        `UPDATE history_blob SET refcount = refcount + 1 WHERE hash = ?`
      ),
    };
    logger.debug('HistoryService constructed', {
      schemaVersion: deps.metaDb.schemaVersion(),
    });
  }

  // ===== L1 =====

  async recordChunk(input: RecordChunkInput): Promise<RecordChunkResult> {
    const baseHash = await this.deps.blobStore.put(input.baseContent);
    const targetHash = await this.deps.blobStore.put(input.targetContent);
    const now = Date.now();

    const apply = this.deps.metaDb.db.transaction(() => {
      const result = this.stmts.insertChunk.run(
        input.projectId,
        input.fileId,
        input.versionFrom,
        input.versionTo,
        baseHash,
        targetHash,
        input.opCount,
        input.primaryActor,
        now
      );
      this.stmts.incRefBlob.run(baseHash);
      this.stmts.incRefBlob.run(targetHash);
      return Number(result.lastInsertRowid);
    });
    const chunkId = apply();
    return {
      chunkId,
      baseBlob: toHex(baseHash),
      targetBlob: toHex(targetHash),
    };
  }

  async listChunks(projectId: string, fileId: string, limit = 100): Promise<HistoryChunk[]> {
    const rows = this.stmts.listChunks.all(projectId, fileId, limit) as Array<{
      id: number;
      project_id: string;
      file_id: string;
      version_from: number;
      version_to: number;
      base_blob: Uint8Array;
      target_blob: Uint8Array;
      op_count: number;
      primary_actor: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      fileId: r.file_id,
      versionFrom: r.version_from,
      versionTo: r.version_to,
      baseBlob: new Uint8Array(r.base_blob),
      targetBlob: new Uint8Array(r.target_blob),
      opCount: r.op_count,
      primaryActor: r.primary_actor,
      createdAt: r.created_at,
    }));
  }

  async createLabel(input: CreateLabelInput): Promise<HistoryLabel> {
    // crypto.randomUUID() ≠ ULID time-sorting, but `created_at` already sorts
    // labels; the id is just an opaque key. If a future P5 wants ULID, swap
    // here without touching callers.
    const id = randomUUID();
    const now = Date.now();
    const description = input.description ?? null;

    const apply = this.deps.metaDb.db.transaction(() => {
      this.stmts.insertLabel.run(
        id,
        input.projectId,
        input.name,
        description,
        input.kind,
        now,
        input.createdBy
      );
      for (const f of input.files) {
        const blobHash = fromHex(f.blobHashHex);
        this.stmts.insertLabelFile.run(id, f.fileId, blobHash, f.version);
        this.stmts.incRefBlob.run(blobHash);
      }
    });
    apply();

    return {
      id,
      projectId: input.projectId,
      name: input.name,
      description,
      kind: input.kind,
      createdAt: now,
      createdBy: input.createdBy,
    };
  }

  async listLabels(projectId: string, limit = 50): Promise<HistoryLabel[]> {
    const rows = this.stmts.listLabels.all(projectId, limit) as Array<{
      id: string;
      project_id: string;
      name: string;
      description: string | null;
      kind: LabelKind;
      created_at: number;
      created_by: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  async resolveLabelSnapshot(labelId: string): Promise<Map<string, Uint8Array>> {
    const files = this.stmts.listLabelFiles.all(labelId) as Array<{
      file_id: string;
      blob_hash: Uint8Array;
      version: number;
    }>;
    const map = new Map<string, Uint8Array>();
    for (const row of files) {
      const bytes = await this.deps.blobStore.get(new Uint8Array(row.blob_hash));
      if (bytes) map.set(row.file_id, bytes);
    }
    return map;
  }

  // ===== L2 =====

  /**
   * Create a session row if absent. Idempotent on `id` — required because
   * `history_step.session_id` carries a FK constraint, so the step writer
   * must be able to upsert the session it belongs to.
   */
  ensureSession(input: {
    id: string;
    projectId: string;
    chatThreadId: string | null;
    parentSession: string | null;
  }): void {
    this.stmts.insertSession.run(
      input.id,
      input.projectId,
      input.chatThreadId,
      null,
      input.parentSession,
      Date.now()
    );
  }

  async recordStep(input: RecordStepInput): Promise<HistoryStep> {
    const treeCanonical = canonicalTreeJson(input.tree);
    const treeBytes = new TextEncoder().encode(treeCanonical);
    const treeHash = await this.deps.blobStore.put(treeBytes);

    const causesBytes = new TextEncoder().encode(JSON.stringify(input.causes));
    const parentHash = input.parentStepHashHex ? fromHex(input.parentStepHashHex) : null;

    const hash = computeStepHash({
      parentHashHex: input.parentStepHashHex,
      treeHashHex: toHex(treeHash),
      sessionId: input.sessionId,
      ts: input.ts,
      causesBytes,
    });

    const apply = this.deps.metaDb.db.transaction(() => {
      this.stmts.insertStep.run(
        hash,
        parentHash,
        input.projectId,
        input.sessionId,
        treeHash,
        causesBytes,
        input.origin,
        input.ts,
        input.sizeDelta
      );
      this.stmts.incRefBlob.run(treeHash);
      for (const file of input.tree) {
        const blobHash = fromHex(file.blobHashHex);
        this.stmts.insertStepFile.run(hash, file.fileId, blobHash);
        this.stmts.incRefBlob.run(blobHash);
      }
    });
    apply();

    return {
      hash,
      parentHash,
      projectId: input.projectId,
      sessionId: input.sessionId,
      treeHash,
      causes: causesBytes,
      origin: input.origin,
      ts: input.ts,
      sizeDelta: input.sizeDelta,
    };
  }

  async getStep(hashHex: HashHex): Promise<HistoryStep | null> {
    const hash = fromHex(hashHex);
    const row = this.stmts.getStep.get(hash) as StepRow | undefined;
    if (!row) return null;
    return rowToStep(row);
  }

  async listSessionSteps(sessionId: string, limit = 200): Promise<HistoryStep[]> {
    const rows = this.stmts.listSessionSteps.all(sessionId, limit) as StepRow[];
    return rows.map(rowToStep);
  }

  async dispose(): Promise<void> {
    await this.deps.blobStore.dispose();
    this.deps.metaDb.close();
  }
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  return new HistoryService(deps);
}

// ----- helpers -----

interface StepRow {
  hash: Uint8Array;
  parent_hash: Uint8Array | null;
  project_id: string;
  session_id: string;
  tree_hash: Uint8Array;
  causes: Uint8Array;
  origin: StepOrigin;
  ts: number;
  size_delta: number;
}

function canonicalTreeJson(tree: Array<{ fileId: string; blobHashHex: HashHex }>): string {
  const sorted = [...tree].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  return JSON.stringify(sorted);
}

/**
 * Step hash = SHA-256 of pipe-delimited (parent | tree | session | ts | causes).
 * Pipe-delimited stays independent of JSON formatting drift.
 */
function computeStepHash(input: {
  parentHashHex: HashHex | null;
  treeHashHex: HashHex;
  sessionId: string;
  ts: number;
  causesBytes: Uint8Array;
}): Hash {
  const causesHex = bytesToHex(input.causesBytes);
  const canonical = `${input.parentHashHex ?? ''}|${input.treeHashHex}|${input.sessionId}|${input.ts}|${causesHex}`;
  const digest = createHash('sha256').update(canonical).digest();
  return new Uint8Array(digest);
}

function toHex(hash: Hash): string {
  let out = '';
  for (let i = 0; i < hash.length; i++) out += hash[i].toString(16).padStart(2, '0');
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: HashHex): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function rowToStep(row: StepRow): HistoryStep {
  return {
    hash: new Uint8Array(row.hash),
    parentHash: row.parent_hash ? new Uint8Array(row.parent_hash) : null,
    projectId: row.project_id,
    sessionId: row.session_id,
    treeHash: new Uint8Array(row.tree_hash),
    causes: new Uint8Array(row.causes),
    origin: row.origin,
    ts: row.ts,
    sizeDelta: row.size_delta,
  };
}
