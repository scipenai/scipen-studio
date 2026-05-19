/**
 * @file AgentEditProposalBridge — host_applies orchestration on renderer side.
 *
 * Wires SNACA `edit.propose` / `edit.propose.complete` events into the existing
 * `DiffReviewService` (reused from the OT path), then translates the user's
 * Diff Review decision back into `agent.resolveEditProposal` IPC calls so
 * main can apply the edit on disk and notify SNACA.
 *
 * P1 scope:
 *   - Non-streaming proposals (the only kind SNACA emits today).
 *   - Open file in editor if not already open so the Monaco-based DiffReview
 *     UI has somewhere to draw.
 *   - Accept All / Reject All are first-class. Per-hunk button clicks degrade
 *     to "last action wins" because diff-match-patch hunks don't map 1:1 to
 *     SNACA hunks (each side computes its own diff). Refining this is left
 *     for a follow-up that exposes SNACA hunk ids on the review object.
 */

import { agentClient } from './AgentClientService';
import { chatStreamStore } from './ChatStreamStore';
import { getDiffReviewService } from '../core/DiffReviewService';
import { getEditorService, getProjectService } from '../core';
import { openFileInEditor } from '../core/FileOpenService';
import { createLogger } from '../LogService';

const logger = createLogger('AgentEditProposalBridge');

interface ProposalSnapshot {
  proposalId: string;
  /** Absolute, forward-slash normalized. */
  absoluteFile: string;
  /** Last hunk set the bridge has materialized into the review. */
  hunks: Array<{
    hunkId: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    oldText: string;
    newText: string;
  }>;
  /** DiffReviewService review id assigned after `createReview`. */
  reviewId: string | null;
  /**
   * Last action observed on the review. Used to derive the resolution
   * decision when the review is removed.
   */
  lastAction: 'accept' | 'reject' | null;
}

class AgentEditProposalBridgeImpl {
  private subscribed = false;
  private readonly byProposal = new Map<string, ProposalSnapshot>();
  private readonly byReview = new Map<string, string>(); // reviewId → proposalId

  /** Idempotent — first caller wires up the listeners. */
  init(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    agentClient.onEditPropose((evt) => {
      void this.handlePropose(evt);
    });
    agentClient.onEditProposeComplete((evt) => {
      void this.handleProposeComplete(evt);
    });

    const reviewService = getDiffReviewService();
    reviewService.onDidResolveAction((action) => {
      const proposalId = this.byReview.get(action.reviewId);
      if (!proposalId) return;
      const snapshot = this.byProposal.get(proposalId);
      if (!snapshot) return;
      snapshot.lastAction = action.action.startsWith('accept') ? 'accept' : 'reject';
    });
    reviewService.onDidRemoveReview((reviewId) => {
      const proposalId = this.byReview.get(reviewId);
      if (!proposalId) return;
      this.dispatchResolution(proposalId).catch((err) => {
        logger.error('dispatchResolution threw', {
          proposalId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  // ====== Inbound (SNACA → DiffReview) ======

  private async handlePropose(evt: {
    proposal_id: string;
    file: string;
    streaming: boolean;
    hunks: Array<{
      hunk_id: string;
      range: {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
      old_text: string;
      new_text: string;
    }>;
  }): Promise<void> {
    // P1: skip the streaming intermediates; the `complete` event carries
    // the canonical final state.
    if (evt.streaming) return;
    await this.materialize(evt.proposal_id, evt.file, evt.hunks);
  }

  private async handleProposeComplete(evt: {
    proposal_id: string;
    final_hunks: Array<{
      hunk_id: string;
      range: {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
      old_text: string;
      new_text: string;
    }>;
  }): Promise<void> {
    const existing = this.byProposal.get(evt.proposal_id);
    if (!existing) {
      // We never saw the initial `propose`. Without a file path we can't
      // materialize a review; drop and let the LLM time out / surface error.
      return;
    }
    await this.materialize(evt.proposal_id, existing.absoluteFile, evt.final_hunks);
  }

  private async materialize(
    proposalId: string,
    file: string,
    hunks: Array<{
      hunk_id: string;
      range: {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
      old_text: string;
      new_text: string;
    }>
  ): Promise<void> {
    const absoluteFile = await this.resolveAbsolute(file);

    // Ensure the file is open so DiffReview decorations have a Monaco model.
    await this.ensureOpen(absoluteFile);

    const editor = getEditorService();
    const tab = editor.tabs.find((t) => sameAbsolute(t.path, absoluteFile));
    if (!tab) {
      // Could not open — give up silently. We don't reject the proposal
      // here because the bridge has no way to call back into SNACA (main
      // owns that); main will surface a timeout if needed.
      return;
    }

    const originalContent = tab.content;
    const newContent = applyHunksToString(originalContent, hunks);

    const reviewService = getDiffReviewService();
    const review = reviewService.createReview(absoluteFile, absoluteFile, originalContent, newContent, {
      reviewKey: {
        backend: 'local',
        projectId: getProjectService().projectPath ?? '__snaca__',
        fileId: absoluteFile,
      },
    });
    if (!review) return;

    // Drop any stale review id for this proposal (re-materialize on complete).
    const prev = this.byProposal.get(proposalId);
    if (prev?.reviewId && prev.reviewId !== review.id) {
      this.byReview.delete(prev.reviewId);
    }

    this.byProposal.set(proposalId, {
      proposalId,
      absoluteFile,
      hunks: hunks.map((h) => ({
        hunkId: h.hunk_id,
        range: h.range,
        oldText: h.old_text,
        newText: h.new_text,
      })),
      reviewId: review.id,
      lastAction: null,
    });
    this.byReview.set(review.id, proposalId);
  }

  // ====== Outbound (DiffReview → SNACA) ======

  private async dispatchResolution(proposalId: string): Promise<void> {
    const snapshot = this.byProposal.get(proposalId);
    if (!snapshot) return;
    this.byProposal.delete(proposalId);
    if (snapshot.reviewId) {
      this.byReview.delete(snapshot.reviewId);
    }

    // P1: last action wins. accept_all → 'accept', reject_all → 'reject',
    // null (review removed without action — shouldn't happen here) → 'reject'
    // as a safe default.
    const decision: 'accept' | 'reject' = snapshot.lastAction === 'accept' ? 'accept' : 'reject';

    // Flip the chat-side proposal card before the IPC round-trip. SNACA
    // doesn't emit a reject event of its own, so this is the only signal
    // the chat panel ever gets for that path. Accept is idempotent — the
    // upcoming `edit.applied` event will set it again.
    chatStreamStore.markProposalResolved(
      proposalId,
      decision === 'accept' ? 'accepted' : 'rejected'
    );

    const result = await agentClient.resolveEditProposal({
      proposalId,
      decision,
      workspaceRoot: getProjectService().projectPath ?? undefined,
    });

    // host_applies path: when `decision === 'accept'` but the main side
    // refused to write (typically `old_text` mismatch because the file
    // moved underfoot), the renderer's `onEditApplied` listener never
    // fires and the Monaco buffer keeps its pre-review content. The
    // review UI is already gone — surface the failure so dev/users can
    // see why the edit silently vanished.
    if (decision === 'accept' && result && result.applied === false) {
      const detail = result.errors?.map((e) => `${e.hunkId}: ${e.message}`).join('; ') ?? 'unknown';
      logger.error('SNACA edit accepted but host refused to apply', {
        proposalId,
        file: snapshot.absoluteFile,
        detail,
      });
      // Loud in DevTools so failures don't disappear into the log file.
      console.error(`[SNACA] Failed to apply edit (${detail})`);
    }
  }

  // ====== Helpers ======

  private async resolveAbsolute(file: string): Promise<string> {
    const normalized = file.replace(/\\/g, '/');
    if (isAbsolutePath(normalized)) return normalized;
    const root = getProjectService().projectPath;
    if (!root) return normalized;
    const normRoot = root.replace(/\\/g, '/');
    return `${normRoot}${normRoot.endsWith('/') ? '' : '/'}${normalized}`;
  }

  private async ensureOpen(absoluteFile: string): Promise<void> {
    const editor = getEditorService();
    const already = editor.tabs.some((t) => sameAbsolute(t.path, absoluteFile));
    if (already) return;
    await openFileInEditor(absoluteFile);
  }
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:\/|\/\/|\/)/.test(p);
}

function sameAbsolute(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Apply hunks to a string in reverse order to keep earlier offsets valid.
 * Mirrors the algorithm in `AgentEditApplyService` on the main side; both
 * sides must agree because main writes the final disk state and renderer
 * pre-computes the same `newContent` to show in the diff.
 */
function applyHunksToString(
  content: string,
  hunks: Array<{
    range: { start: { line: number; column: number }; end: { line: number; column: number } };
    new_text: string;
  }>
): string {
  const sorted = [...hunks].sort((a, b) => {
    const dl = b.range.start.line - a.range.start.line;
    if (dl !== 0) return dl;
    return b.range.start.column - a.range.start.column;
  });
  let result = content;
  for (const hunk of sorted) {
    const startOffset = lineColumnToOffset(result, hunk.range.start.line, hunk.range.start.column);
    const endOffset = lineColumnToOffset(result, hunk.range.end.line, hunk.range.end.column);
    result = result.slice(0, startOffset) + hunk.new_text + result.slice(endOffset);
  }
  return result;
}

function lineColumnToOffset(content: string, line: number, column: number): number {
  if (line === 0) return Math.min(column, content.length);
  let offset = 0;
  for (let ln = 0; ln < line; ln++) {
    const idx = content.indexOf('\n', offset);
    if (idx === -1) return content.length;
    offset = idx + 1;
  }
  const lineEnd = content.indexOf('\n', offset);
  const lineCap = lineEnd === -1 ? content.length : lineEnd;
  return Math.min(offset + column, lineCap);
}

export const agentEditProposalBridge = new AgentEditProposalBridgeImpl();
