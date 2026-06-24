/**
 * @file Shared types for the history system.
 *
 * Mirrors the SQLite schema documented in `.cursor/plans/history-system.md` §3.1
 * and §4.1. Hashes flow through the JS layer as `Uint8Array` (binary, 32 bytes
 * for BLAKE3-256); only the IPC/serialization boundary converts to lowercase hex
 * strings. This avoids string churn on hot paths (every chunk flush hashes a
 * full file blob).
 */

/** BLAKE3-256 hash. Always 32 bytes. */
export type Hash = Uint8Array;

/** Lowercase-hex hash for logs/IPC/UI. */
export type HashHex = string;

export type StepOrigin = 'snaca_tool' | 'human_edit' | 'merge';

export type LabelKind = 'manual' | 'auto' | 'milestone';

/**
 * Content-addressed blob record. `bytes` is inlined only when `size` is below
 * the inline threshold (default 4KB — matches SQLite page size); larger blobs
 * live on disk under `{projectRoot}/history/blobs/{hash[0:2]}/{hash}`.
 */
export interface HistoryBlob {
  hash: Hash;
  size: number;
  refcount: number;
  createdAt: number;
  /** Only present for inline blobs. */
  bytes?: Uint8Array;
}

/**
 * A contiguous run of OT ops translated into "where the file went". `baseBlob`
 * → `targetBlob` is the closure; ops themselves stay in the L0 operations table.
 */
export interface HistoryChunk {
  id: number;
  projectId: string;
  fileId: string;
  versionFrom: number;
  versionTo: number;
  baseBlob: Hash;
  targetBlob: Hash;
  opCount: number;
  primaryActor: string | null;
  createdAt: number;
}

/** User-visible named snapshot spanning multiple files (a "milestone"). */
export interface HistoryLabel {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  kind: LabelKind;
  createdAt: number;
  createdBy: string;
}

/** Per-file pointer inside a label. */
export interface HistoryLabelFile {
  labelId: string;
  fileId: string;
  blobHash: Hash;
  version: number;
}

/**
 * One SNACA tool turn or one human-edit batch. The step DAG is keyed by its
 * BLAKE3 hash of the canonical encoding of (parent, tree, causes, session, ts)
 * — identical inputs collide intentionally for free dedup.
 */
export interface HistoryStep {
  hash: Hash;
  parentHash: Hash | null;
  projectId: string;
  sessionId: string;
  /** Merkle root over (fileId → blobHash) ordered by fileId. */
  treeHash: Hash;
  /** msgpack-encoded `Cause[]`. */
  causes: Uint8Array;
  origin: StepOrigin;
  ts: number;
  sizeDelta: number;
}

/** Causes are SNACA tool calls or human-edit batches; each step carries one or more. */
export interface Cause {
  toolName: string;
  argsJson?: string;
  resultSummary?: string;
}

/** A branch in the DAG. One chat thread maps to one session by default. */
export interface HistorySession {
  id: string;
  projectId: string;
  chatThreadId: string | null;
  headStepHash: Hash | null;
  parentSession: string | null;
  createdAt: number;
  closedAt: number | null;
}

/**
 * Tunable knobs. Centralized so tests can monkey-patch and so the chunk-write
 * cadence can move with project size without touching the writer.
 */
export interface HistoryConfig {
  /** Inline-vs-file threshold for blob bytes. Default 4096. */
  blobInlineMaxBytes: number;
  /** Flush a chunk after this many ops accumulate. */
  chunkFlushOps: number;
  /** Flush a chunk if this much time has passed since the first pending op. */
  chunkFlushIdleMs: number;
  /** Step write debounce for human-edit batches. */
  humanStepIdleMs: number;
  /** Step force-flush when a human batch hits this many ops. */
  humanStepMaxOps: number;
}

export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  blobInlineMaxBytes: 4096,
  chunkFlushOps: 100,
  chunkFlushIdleMs: 30_000,
  humanStepIdleMs: 5_000,
  humanStepMaxOps: 100,
};
