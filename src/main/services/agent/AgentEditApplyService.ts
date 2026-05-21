/**
 * @file AgentEditApplyService - host_applies path for SNACA edit.propose.
 *
 * Caches every `edit.propose` (and final `edit.propose.complete`) it sees on
 * the protocol client, then mutates the workspace file when the renderer
 * issues a `resolve` call. After a successful mutation it forwards
 * `editConfirm` to SNACA so the LLM can continue, and emits `onEditApplied`
 * so the renderer can sync its Monaco model.
 *
 * Hunk semantics (per `editor-protocol::Range`):
 *   - 0-based line / column
 *   - `end` is exclusive
 *   - column is a UTF-16 code-unit count (JS string index is the same unit)
 *   - hunks are non-overlapping and sorted by `start` ascending; apply in
 *     REVERSE order so earlier indexes stay valid.
 */

import { createHash } from 'node:crypto';
import { Emitter, type Event } from '@shared/utils/event';
import { DisposableStore } from '@shared/utils/lifecycle';
import { createLogger } from '../LoggerService';
import type { IFileSystemService } from '../interfaces';
import type { IEditorProtocolClient } from './interfaces/IEditorProtocolClient';
import type {
  AgentEditAppliedPayload,
  AgentResolveEditProposalParams,
  AgentResolveEditProposalResult,
  IAgentEditApplyService,
} from './interfaces/IAgentEditApplyService';
import type {
  EditProposeParams,
  LineHunk,
  PerHunkChoice,
} from './protocol/schemas';

const logger = createLogger('AgentEditApply');

interface CachedProposal {
  /** Last seen propose snapshot — overwritten on `edit.propose.complete`. */
  params: EditProposeParams;
  /** Best-effort absolute file path on disk. */
  absoluteFile: string;
}

export interface AgentEditApplyServiceDeps {
  client: IEditorProtocolClient;
  fileSystem: IFileSystemService;
}

export class AgentEditApplyService implements IAgentEditApplyService {
  private readonly _onEditApplied = new Emitter<AgentEditAppliedPayload>();
  readonly onEditApplied: Event<AgentEditAppliedPayload> = this._onEditApplied.event;

  private readonly proposals = new Map<string, CachedProposal>();
  private readonly _disposables = new DisposableStore();

  constructor(private readonly deps: AgentEditApplyServiceDeps) {
    this._disposables.add(
      deps.client.onEditPropose((event) => {
        this.proposals.set(event.proposal_id, {
          params: event,
          absoluteFile: normalizeAbs(event.file),
        });
      })
    );
    this._disposables.add(
      deps.client.onEditProposeComplete((event) => {
        const cached = this.proposals.get(event.proposal_id);
        if (!cached) {
          logger.warn('edit.propose.complete for unknown proposal', {
            proposalId: event.proposal_id,
          });
          return;
        }
        // Replace hunks with the final snapshot. Other fields stay the same.
        cached.params = { ...cached.params, hunks: event.final_hunks, streaming: false };
      })
    );
  }

  async resolve(
    params: AgentResolveEditProposalParams
  ): Promise<AgentResolveEditProposalResult> {
    const cached = this.proposals.get(params.proposalId);
    if (!cached) {
      throw new Error(`Unknown proposal: ${params.proposalId}`);
    }

    if (params.decision === 'reject') {
      const confirmResult = await this.deps.client.editConfirm({
        proposal_id: params.proposalId,
        decision: 'reject',
      });
      this.proposals.delete(params.proposalId);
      return { applied: false, confirmResult };
    }

    const acceptedHunks = filterAcceptedHunks(
      cached.params.hunks,
      params.decision,
      params.perHunk
    );

    if (acceptedHunks.length === 0) {
      // Treat "accept_partial with all rejected" as a regular reject so the
      // LLM gets the same signal.
      const confirmResult = await this.deps.client.editConfirm({
        proposal_id: params.proposalId,
        decision: 'reject',
      });
      this.proposals.delete(params.proposalId);
      return { applied: false, confirmResult };
    }

    const absoluteFile = resolveAbsolute(cached.absoluteFile, params.workspaceRoot);
    const fileResult = await this.deps.fileSystem.readFile(absoluteFile);
    const original = fileResult.content;

    const errors: Array<{ hunkId: string; message: string }> = [];
    const newContent = applyHunks(original, acceptedHunks, errors);

    if (errors.length > 0) {
      logger.warn('edit.propose apply: hunk mismatch — aborting write', {
        proposalId: params.proposalId,
        errors,
      });
      return { applied: false, errors };
    }

    await this.deps.fileSystem.writeFile(absoluteFile, newContent);
    const appliedHash = sha256Hex(newContent);
    const mtimeMs = Date.now();
    // Keep `IFileSystemService.getCachedMtime()` consistent so the conflict
    // detector doesn't fire on our own write.
    this.deps.fileSystem.updateFileMtime(absoluteFile, mtimeMs);

    const confirmResult = await this.deps.client.editConfirm({
      proposal_id: params.proposalId,
      decision: params.decision,
      per_hunk: params.perHunk?.map((h) => ({
        hunk_id: h.hunkId,
        decision: h.decision as PerHunkChoice,
      })),
    });

    this._onEditApplied.fire({
      proposalId: params.proposalId,
      file: absoluteFile,
      content: newContent,
      appliedHash,
      mtimeMs,
    });

    this.proposals.delete(params.proposalId);
    return { applied: true, appliedHash, confirmResult };
  }

  dispose(): void {
    this._disposables.dispose();
    this._onEditApplied.dispose();
    this.proposals.clear();
  }
}

export function createAgentEditApplyService(
  deps: AgentEditApplyServiceDeps
): AgentEditApplyService {
  return new AgentEditApplyService(deps);
}

// ============ Hunk math ============

function filterAcceptedHunks(
  hunks: LineHunk[],
  decision: AgentResolveEditProposalParams['decision'],
  perHunk: AgentResolveEditProposalParams['perHunk']
): LineHunk[] {
  if (decision === 'accept') return [...hunks];
  if (decision !== 'accept_partial') return [];
  if (!perHunk || perHunk.length === 0) return [];
  const accepted = new Set(perHunk.filter((h) => h.decision === 'accept').map((h) => h.hunkId));
  return hunks.filter((h) => accepted.has(h.hunk_id));
}

function applyHunks(
  content: string,
  hunks: LineHunk[],
  errors: Array<{ hunkId: string; message: string }>
): string {
  // Normalize EVERYTHING to LF before hunk arithmetic. SNACA's Rust backend
  // reads files raw and stores the source EOL verbatim in `old_text` /
  // `new_text` (see approval_gate.rs ~L115-156), while line numbers are
  // counted by `\n` only. So on Windows we see LF line numbers but CRLF
  // text payloads — comparing them against a CRLF-content slice fails the
  // `old_text === slice` check, which silently aborts every write.
  //
  // Normalizing all three (content + old_text + new_text) lets the
  // comparison and splicing operate in a single, predictable EOL space.
  // We restore the original on-disk EOL before returning so the file keeps
  // its convention (mixed-EOL files homogenize to the dominant style,
  // matching how most editors behave).
  const originalEol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = originalEol === '\r\n' ? content.replace(/\r\n/g, '\n') : content;
  const normalizedHunks = hunks.map((h) =>
    h.old_text.includes('\r\n') || h.new_text.includes('\r\n')
      ? {
          ...h,
          old_text: h.old_text.replace(/\r\n/g, '\n'),
          new_text: h.new_text.replace(/\r\n/g, '\n'),
        }
      : h
  );

  // Sort by start descending so earlier hunks' offsets stay valid as we splice.
  const sorted = [...normalizedHunks].sort((a, b) => {
    const dl = b.range.start.line - a.range.start.line;
    if (dl !== 0) return dl;
    return b.range.start.column - a.range.start.column;
  });

  let result = normalized;
  for (const hunk of sorted) {
    const startOffset = lineColumnToOffset(result, hunk.range.start.line, hunk.range.start.column);
    const endOffset = lineColumnToOffset(result, hunk.range.end.line, hunk.range.end.column);
    const slice = result.slice(startOffset, endOffset);
    if (slice !== hunk.old_text) {
      errors.push({
        hunkId: hunk.hunk_id,
        message: `old_text mismatch at ${hunk.range.start.line}:${hunk.range.start.column}-${hunk.range.end.line}:${hunk.range.end.column}`,
      });
      continue;
    }
    result = result.slice(0, startOffset) + hunk.new_text + result.slice(endOffset);
  }
  return originalEol === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
}

/** Convert {line, column} (0-based, UTF-16 code units) to a string index. */
function lineColumnToOffset(content: string, line: number, column: number): number {
  if (line === 0) return Math.min(column, content.length);
  let offset = 0;
  for (let ln = 0; ln < line; ln++) {
    const idx = content.indexOf('\n', offset);
    if (idx === -1) return content.length;
    offset = idx + 1;
  }
  // Cap column at the end of the line so a malformed end position degrades
  // gracefully rather than landing inside the next line.
  const lineEnd = content.indexOf('\n', offset);
  const lineCap = lineEnd === -1 ? content.length : lineEnd;
  return Math.min(offset + column, lineCap);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function normalizeAbs(p: string): string {
  return p.replace(/\\/g, '/');
}

function resolveAbsolute(file: string, workspaceRoot?: string): string {
  if (isAbsolute(file) || !workspaceRoot) return file;
  const root = normalizeAbs(workspaceRoot);
  const sep = root.endsWith('/') ? '' : '/';
  return `${root}${sep}${file}`;
}

function isAbsolute(p: string): boolean {
  // Windows: C:/... or //server/share. Unix: /...
  return /^([a-zA-Z]:\/|\/\/|\/)/.test(normalizeAbs(p));
}
