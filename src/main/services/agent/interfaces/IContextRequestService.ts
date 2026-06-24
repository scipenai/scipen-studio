/**
 * @file IContextRequestService — answers SNACA's reverse-RPC `context.request`.
 *
 * SNACA's tools (notably `Read`) call `context.request` to ask the host for
 * fresh state before reading disk — most importantly `flush_unsaved`, which
 * needs the renderer to save dirty Monaco tabs first.
 *
 * Implementations bind to `IEditorProtocolClient.setContextRequestHandler`.
 */

import type { IDisposable } from '@shared/utils/lifecycle';
import type { ContextRequestParams, ContextRespondParams } from '../protocol/schemas';

export interface ContextFlushResponsePayload {
  requestId: string;
  /** Renderer-reported list of files actually flushed (project-relative or absolute). */
  flushedFiles: string[];
}

/**
 * Renderer's reply to a `Agent_ContextZoteroRequest`. The `data` field
 * is shaped per-kind by the responder; the service just hands it back
 * to the awaiting handler which wraps it in the right Zod-validated
 * `ContextPayload` variant.
 */
export interface ContextZoteroResponsePayload {
  requestId: string;
  ok: boolean;
  /** Per-kind body; see `ContextZoteroResponder` for shapes. */
  data?: unknown;
  error?: string;
}

/**
 * Renderer's reply to an `Agent_UserQuestionRequest`. `answers` carries
 * the user's selection per question (wire-shaped `QuestionAnswers`); the
 * service wraps it in the `ask_user_question` `ContextPayload` variant.
 */
export interface ContextQuestionResponsePayload {
  requestId: string;
  ok: boolean;
  /** Wire `QuestionAnswers`: `{ answers, user_id, decided_at }`. */
  answers?: unknown;
  error?: string;
}

export interface IContextRequestService extends IDisposable {
  /**
   * Reverse-RPC dispatcher. Wire this to
   * `IEditorProtocolClient.setContextRequestHandler` once at registration time.
   */
  handle(req: ContextRequestParams): Promise<ContextRespondParams>;

  /**
   * Called by the IPC layer when the renderer replies to a
   * `Agent_ContextFlushRequest` with its `flushed_files` list. Resolves the
   * pending promise that `handle()` is awaiting.
   */
  completeFlush(payload: ContextFlushResponsePayload): void;

  /**
   * Called by the IPC layer when the renderer replies to a
   * `Agent_ContextZoteroRequest`. Resolves the pending promise that
   * `handle()` is awaiting for one of the three `zotero_*` kinds.
   */
  completeZotero(payload: ContextZoteroResponsePayload): void;

  /**
   * Called by the IPC layer when the renderer replies to an
   * `Agent_UserQuestionRequest` (the user submitted the question card).
   * Resolves the pending promise `handle()` awaits for `ask_user_question`.
   */
  completeQuestion(payload: ContextQuestionResponsePayload): void;

  /**
   * Reclaim every pending entry whose `turn_id` matches. Called by the
   * wiring layer when a turn ends — either because the host actively
   * cancelled it (`turnCancel`) or because SNACA emitted a terminal
   * `turn.delta { kind: 'done' }`. Without this, a turn cancel can leave
   * an `ask_user_question` pending for up to 600 s.
   *
   * Idempotent. Replies `ok:false` to SNACA so the protocol layer stays
   * consistent — SNACA will normally ignore those replies because the
   * turn is already terminated on its side, but a friendly `ok:false`
   * beats a silent leak if SNACA's cleanup raced behind the cancel.
   */
  cancelTurn(turnId: string): void;
}
