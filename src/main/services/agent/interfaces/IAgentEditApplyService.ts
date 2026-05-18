/**
 * @file IAgentEditApplyService - host_applies path for SNACA edit.propose
 *
 * SNACA proposes edits as `LineHunk[]` against a `base_hash`. The renderer
 * surfaces a Diff Review; once the user decides, the renderer asks main
 * to actually mutate the file (host_applies strategy). This service owns
 * that mutation:
 *
 *   - looks up the cached proposal by id
 *   - reads the current file, validates `base_hash`
 *   - applies the (possibly partial) accepted hunks
 *   - writes the file via `IFileSystemService.writeFile`
 *   - forwards `editConfirm` to SNACA so the LLM keeps going
 *   - emits `onEditApplied` so the renderer can sync the Monaco model
 *
 * Reject path: skips fs write, only forwards `editConfirm({decision:'reject'})`.
 */

import type { Event } from '@shared/utils/event';
import type { IDisposable } from '@shared/utils/lifecycle';
import type { EditConfirmResult } from '../protocol/schemas';

export interface AgentResolveEditProposalParams {
  proposalId: string;
  decision: 'accept' | 'reject' | 'accept_partial';
  /** Per-hunk decisions; only consulted when `decision === 'accept_partial'`. */
  perHunk?: Array<{ hunkId: string; decision: 'accept' | 'reject' }>;
  /**
   * Workspace root used to resolve relative paths in the proposal. SNACA
   * normally emits absolute paths but we accept either for robustness.
   */
  workspaceRoot?: string;
}

export interface AgentResolveEditProposalResult {
  /** True if the file was actually written. False for reject / no-op. */
  applied: boolean;
  /** sha256 of the post-write content (lowercase hex). */
  appliedHash?: string;
  /** Per-hunk failure detail (e.g., old_text mismatch). */
  errors?: Array<{ hunkId: string; message: string }>;
  /** Echoes SNACA's `editConfirm` reply for traceability. */
  confirmResult?: EditConfirmResult;
}

export interface AgentEditAppliedPayload {
  proposalId: string;
  /** Absolute file path that was written. */
  file: string;
  /** Post-write content (so renderer can sync Monaco model). */
  content: string;
  /** sha256 lowercase hex. */
  appliedHash: string;
  /** Filesystem mtime in ms (so renderer can refresh conflict tracking). */
  mtimeMs: number;
}

export interface IAgentEditApplyService extends IDisposable {
  /**
   * Fired after a successful accept that mutates a file. Renderer listens
   * via the IPC fan-out (`Agent_EditApplied` channel).
   */
  readonly onEditApplied: Event<AgentEditAppliedPayload>;

  /**
   * Apply the user's decision on a proposal:
   *   - accept / accept_partial: write file + emit onEditApplied + confirm SNACA
   *   - reject: confirm SNACA only
   *
   * Throws when the proposal id is unknown.
   */
  resolve(params: AgentResolveEditProposalParams): Promise<AgentResolveEditProposalResult>;
}
