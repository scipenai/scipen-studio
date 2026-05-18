/**
 * @file IInlineEditService — Ctrl+K inline edit contract.
 *
 * Studio-direct (B-route) implementation: streams the user's instruction +
 * selected text through the configured `AIService` LLM and pushes deltas
 * back via events. Does NOT touch the SNACA sidecar — Ctrl+K is a
 * single-shot replacement, not an agent turn.
 *
 * Concurrency: callers can have multiple turns in flight (e.g. user opens
 * widget A, hits Esc, opens widget B). Each turn has its own
 * `AbortController`; `cancel(turnId)` only stops the matching one.
 */

import type { Event } from '@shared/utils/event';
import type { IDisposable } from '@shared/utils/lifecycle';

export interface InlineEditStartParams {
  /** User's natural-language instruction, e.g. "make this concise". */
  instruction: string;
  /** The currently selected text to be replaced. */
  selectedText: string;
  /**
   * Language id (`latex` / `typst` / `markdown` / `plaintext` / …). Used to
   * label the code fence in the prompt and to coach the LLM about syntax.
   */
  language: string;
  /** Project-relative or basename file path; used only as a label in the prompt. */
  fileLabel?: string;
  /**
   * Optional ±N lines of surrounding context. The renderer is free to omit
   * it for very long selections; we cap server-side as a defence.
   */
  surroundingContext?: string;
}

export interface InlineEditDeltaEvent {
  turnId: string;
  /** Incremental text chunk. */
  delta: string;
}

export interface InlineEditCompleteEvent {
  turnId: string;
  /** Concatenated, post-sanitised final replacement text. */
  fullText: string;
}

export interface InlineEditErrorEvent {
  turnId: string;
  message: string;
  /** Best-effort classification for UI styling. */
  code?: 'aborted' | 'not_configured' | 'provider_error';
}

export interface IInlineEditService extends IDisposable {
  /**
   * Spawn a streaming inline-edit turn. Resolves with the turn id as soon
   * as the request is launched; deltas arrive via `onDelta`.
   * Throws synchronously if AI service is not configured.
   */
  start(params: InlineEditStartParams): Promise<{ turnId: string }>;

  /**
   * Abort an in-flight turn. No-op if `turnId` is unknown or already done.
   * Returns whether anything was actually cancelled.
   */
  cancel(turnId: string): { ok: boolean };

  readonly onDelta: Event<InlineEditDeltaEvent>;
  readonly onComplete: Event<InlineEditCompleteEvent>;
  readonly onError: Event<InlineEditErrorEvent>;
}
