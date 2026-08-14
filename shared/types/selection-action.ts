/**
 * @file Selection Action DTO
 * @description Unified selection payload shared by editor Ctrl+L and external Alt+D
 *              triggers. Consumed by the SelectionActionCard in ChatSidebar.
 */

export type SelectionAction = 'translate' | 'explain' | 'distill' | 'find_related_lit_local';

/**
 * Payload driving the SelectionActionCard.
 *
 * `source: 'editor'` — Monaco Ctrl+L; sourceApp is always undefined.
 * `source: 'external'` — global hook / shortcut on another window; sourceApp
 *   carries the foreground application name when the native hook exposed it.
 *
 * Screen coordinates from the native hook are intentionally NOT carried
 * here — the card sits inside ChatSidebar (fixed docking), not as a
 * cursor-anchored floating popup, so a coordinate field would be dead
 * data. Add it back only when a floating surface actually needs it.
 */
export interface UnifiedSelection {
  text: string;
  source: 'editor' | 'external';
  sourceApp?: string;
  /**
   * Write-only today; reserved for the planned "captured Ns ago" freshness
   * hint on SelectionActionCard. Every producer stamps it, but no reader
   * exists yet — do not add new producers without adding the reader, and
   * do not remove without checking those planned consumers. Kept in the
   * DTO instead of tacked on later so the wire shape stabilises early.
   *
   * Unit: epoch milliseconds (`Date.now()` / `Date.parse()` output).
   * Deliberately not seconds, and deliberately not the ISO string carried
   * by `SelectionCaptureDTO.capturedAt` — locking the unit now prevents
   * a 1000x-off freshness hint when the first reader lands.
   */
  capturedAt: number;
}

export interface SelectionActionRequest {
  selection: UnifiedSelection;
}
