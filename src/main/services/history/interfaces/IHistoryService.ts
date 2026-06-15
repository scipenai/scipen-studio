/**
 * @file IHistoryService - high-level history API used by IPC and other services.
 * @description The renderer never touches L1/L2 storage directly — every read
 *   and write flows through this contract so the implementation can swap the
 *   backing store (filesystem-only → SQLite → remote) without rippling.
 */

import type {
  Cause,
  HashHex,
  HistoryChunk,
  HistoryLabel,
  HistoryStep,
  LabelKind,
  StepOrigin,
} from '../types';

/** Recorded chunk identity returned to the writer. */
export interface RecordChunkResult {
  chunkId: number;
  baseBlob: HashHex;
  targetBlob: HashHex;
}

export interface RecordChunkInput {
  projectId: string;
  fileId: string;
  versionFrom: number;
  versionTo: number;
  /** Full file content at `versionFrom - 1`. */
  baseContent: Uint8Array;
  /** Full file content at `versionTo`. */
  targetContent: Uint8Array;
  opCount: number;
  primaryActor: string | null;
}

export interface CreateLabelInput {
  projectId: string;
  name: string;
  description?: string;
  kind: LabelKind;
  createdBy: string;
  /** Files included in the label, with each file's hash + version at label time. */
  files: Array<{ fileId: string; blobHashHex: HashHex; version: number }>;
}

export interface RecordStepInput {
  projectId: string;
  sessionId: string;
  parentStepHashHex: HashHex | null;
  /** Per-file (fileId → blob hex) snapshot at this step's instant. */
  tree: Array<{ fileId: string; blobHashHex: HashHex }>;
  causes: Cause[];
  origin: StepOrigin;
  ts: number;
  sizeDelta: number;
}

export interface IHistoryService {
  // ===== L1 — document-level =====

  recordChunk(input: RecordChunkInput): Promise<RecordChunkResult>;
  listChunks(projectId: string, fileId: string, limit?: number): Promise<HistoryChunk[]>;
  createLabel(input: CreateLabelInput): Promise<HistoryLabel>;
  listLabels(projectId: string, limit?: number): Promise<HistoryLabel[]>;
  /** Resolve a label to a file → bytes map by reading the referenced blobs. */
  resolveLabelSnapshot(labelId: string): Promise<Map<string, Uint8Array>>;

  // ===== L2 — AI-session-level =====

  recordStep(input: RecordStepInput): Promise<HistoryStep>;
  getStep(hashHex: HashHex): Promise<HistoryStep | null>;
  listSessionSteps(sessionId: string, limit?: number): Promise<HistoryStep[]>;
  /** Resolve a step to a `Map<fileId, bytes>` snapshot (mirror of resolveLabelSnapshot but for the Step DAG). */
  resolveStepSnapshot(hashHex: HashHex): Promise<Map<string, Uint8Array>>;
  /** Latest step in a session with `ts < beforeTs`, or null if none. Used by "rollback to before this message". */
  findStepBeforeTs(sessionId: string, beforeTs: number): Promise<HistoryStep | null>;

  // ===== Lifecycle =====

  /** Release file handles, flush pending writes. */
  dispose(): Promise<void>;
}
