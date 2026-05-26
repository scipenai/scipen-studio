/**
 * @file Zotero event & snapshot DTOs — wire types for the main-canonical
 *       bib index broadcast (方案 D, D-1)
 * @description Main process is the sole owner of the Zotero index;
 *              renderer mirrors via a single broadcast channel that
 *              carries a discriminated union of events. Snapshots are
 *              pulled on demand via `Zotero_GetSnapshot`.
 *
 *              Etag semantics: every state mutation in the index bumps a
 *              monotonic version string. Renderer stores the last seen
 *              etag and may pass it to `getSnapshot({ since })` to ask
 *              for a delta; main returns either a full reset (`reset:
 *              true`) when the cursor is too old, or a patch payload.
 */

import type { ZoteroItemDTO } from './zotero';

// ============================================================
// Index status state machine
// ============================================================

/**
 * Lifecycle states broadcast on `bib:status`. Renderer should drive
 * banners and tooltips off this rather than poking sources.
 */
export type BibStatus =
  | 'idle'           // Zotero integration not enabled by user yet (wizard not finished)
  | 'bootstrapping'  // First-pass cold load is running
  | 'syncing'        // Incremental refresh in progress
  | 'ready'          // Index is hot and quiescent
  | 'degraded'       // BBT down or LocalApi failed — partial data
  | 'error';         // Hard failure (Zotero misconfigured / unreachable)

/**
 * Diagnostics payload exposed via `Zotero_GetDiagnostics`. Surfaced in
 * the status bar's Zotero panel; keep this serialisable.
 */
export interface ZoteroDiagnosticsDTO {
  status: BibStatus;
  /** Last successful refresh wall-clock time (ISO string). */
  lastSyncedAt?: string;
  /** Source health flags. */
  sources: {
    localApi: { ok: boolean; error?: string };
    betterBibTex: { ok: boolean; error?: string };
  };
  /** Current item count in the canonical index. */
  itemCount: number;
  /** Last etag emitted on `bib:*` events. */
  etag: string;
  /** Active reason for the last `bib:status` transition. */
  detail?: string;
}

// ============================================================
// Snapshot payloads
// ============================================================

/**
 * Initial / full hydration payload. `items` is the entire visible index;
 * for the M1 5k-entry target the JSON encodes to roughly 2-3 MB which is
 * fine on a single one-shot transfer.
 */
export interface BibSnapshotDTO {
  status: BibStatus;
  etag: string;
  items: ZoteroItemDTO[];
}

/**
 * Delta payload from a `since`-cursored `getSnapshot` call. When the
 * caller's cursor predates the in-memory delta log, `reset: true` tells
 * the caller to discard local state and rehydrate from `items` instead.
 */
export interface BibPatchDTO {
  status: BibStatus;
  etag: string;
  reset: false;
  upserts: ZoteroItemDTO[];
  deletes: string[];
}

export interface BibResetDTO {
  status: BibStatus;
  etag: string;
  reset: true;
  items: ZoteroItemDTO[];
}

/** Either a delta (`reset: false`) or a full rehydrate (`reset: true`). */
export type GetSnapshotResultDTO = BibPatchDTO | BibResetDTO;

/** Renderer request shape; absent `since` means "give me the whole index". */
export interface GetSnapshotRequestDTO {
  /** Last etag the caller successfully applied. */
  since?: string;
}

// ============================================================
// Event union (broadcast on Zotero_Event channel)
// ============================================================

export type ZoteroEventDTO =
  | { kind: 'bib:initial'; snapshot: BibSnapshotDTO }
  | { kind: 'bib:patch'; upserts: ZoteroItemDTO[]; deletes: string[]; etag: string; status: BibStatus }
  | { kind: 'bib:invalidated'; reason: 'focus' | 'manual' | 'error-recovery' }
  | { kind: 'bib:status'; status: BibStatus; detail?: string };

/** Manual refresh request. Returns the resulting status synchronously. */
export interface RefreshResultDTO {
  triggered: boolean;
  status: BibStatus;
  detail?: string;
}

/**
 * `references.bib` 同步当前状态。renderer 用此判断 UI 标识(成功 / 跳过 /
 * 冲突 / 失败)。完整生命周期见 `BibTexSyncService`。
 */
export type BibTexSyncStatusDTO =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'ok'; filePath: string; bytesWritten: number; lastSyncedAt: string }
  | { kind: 'skipped-no-change'; filePath: string; lastSyncedAt: string }
  | { kind: 'conflict'; filePath: string; reason: string }
  | { kind: 'error'; reason: string };
