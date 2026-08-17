/**
 * @file ZoteroDataSource — capability facade over "one bibliography backend"
 * @description Unifies the 5 read capabilities the app needs from a Zotero
 *              backend (items / annotations / attachments / fulltext / CSL)
 *              behind a single interface. The orchestrator holds ONE
 *              `ZoteroDataSource` at a time — swapping instances is the
 *              only place mode (local vs web) matters. Downstream code
 *              (IPC handlers, agent reverse-RPC responders, mirror) is
 *              mode-agnostic: they call `source.getItemAnnotations(k)` and
 *              the right client runs underneath.
 *
 * ## Why a facade instead of "handler adds mode branch"
 *
 * The naive fix would be `if (dataSource === 'web') webClient.x() else
 * localClient.x()` in each handler. That scatters the mode judgement across
 * every zotero-related handler and every future data-source addition
 * (group libraries, an alt-cloud provider, …) forces N handlers to change.
 *
 * The facade folds the mode judgement into ONE `resolveActiveSource()` in
 * the orchestrator. Adding a third data source = one new class implementing
 * `ZoteroDataSource`; no handler touched. Open/closed principle.
 *
 * ## Honest sentinels vs silent fallback
 *
 * Some capabilities have no meaningful implementation in every backend
 * (Web API cannot serve BBT CSL; Web API cannot serve local PDF full-text
 * without stage-B lazy download). Instead of silently returning empty
 * arrays / null (which makes the LLM wrongly conclude "this paper has no
 * annotations / no full text"), the Web implementation returns explicit
 * sentinels:
 *   - `getCslByCitationKey` → `null` (BBT-only capability, honestly absent)
 *   - `getFullText`         → `{ tier: 'web_pending', ... }` (deferred to stage B)
 *
 * Downstream can log / surface these to the LLM as capability info rather
 * than pretend the data was zero.
 */

import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroFullTextResultDTO,
  ZoteroItemDTO,
} from '../../../../shared/types/zotero';

export interface ZoteroDataSourceProbe {
  ok: boolean;
  /** Human-friendly failure reason; only present when `ok === false`. */
  error?: string;
  /**
   * Non-fatal note (e.g. "BBT skipped in web mode"). Present regardless of
   * `ok`; useful for diagnostics UI without polluting `error`.
   */
  detail?: string;
}

export interface ZoteroDataSource {
  /**
   * Which backend this facade wraps. Used by orchestrator + diagnostics
   * to surface the active source's identity to the UI; downstream code
   * should NOT branch on this — it's for display only. Branching on kind
   * = re-introducing the per-caller mode judgement we're avoiding.
   */
  readonly kind: 'local' | 'web';

  /**
   * Verify the backend is reachable + credentials valid (if any). Never
   * throws — errors flatten into `{ ok: false, error }` so callers can
   * treat probes as pure functions.
   */
  ping(): Promise<ZoteroDataSourceProbe>;

  /**
   * Full paginated pull of all top-level bibliography items. Orchestrator
   * calls this on refresh. Throws on unrecoverable errors so the
   * orchestrator can transition to `error` state.
   */
  getAllItems(): Promise<ZoteroItemDTO[]>;

  /**
   * Annotations attached to one item's PDF attachment. Returns `[]` when
   * the item has no annotations (this is a legitimate "known-empty"
   * answer — NOT the "backend unavailable" fallback; that path throws).
   */
  getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]>;

  /**
   * Attachment children under one item. Used by full-text resolution to
   * find the PDF. Empty array = no PDF attachment (legitimate).
   */
  getItemAttachments(itemKey: string): Promise<ZoteroAttachmentDTO[]>;

  /**
   * Tier-1 (or better) full-text extraction. Return shape is a discriminated
   * union on `tier`:
   *   - `local`       → real text from local PDF via pdf-parse
   *   - `mineru`      → structured MD from MinerU cloud parse
   *   - `none`        → item genuinely has no PDF (or read failure)
   *   - `web_pending` → **web-mode sentinel**: PDF is in the cloud, lazy
   *                     download is stage-B work. LLM should treat as
   *                     "unavailable, not empty".
   * Never throws — degrades to `{ tier: 'none' | 'web_pending', text: '' }`.
   */
  getFullText(itemKey: string): Promise<ZoteroFullTextResultDTO>;

  /**
   * CSL JSON for one citation key. Returns `null` when:
   *   - The key is unknown to the backend (legitimate miss), or
   *   - The backend cannot serve CSL (web mode — BBT is local-only).
   * The caller cannot distinguish these two cases from the return value
   * alone; that's intentional — LLM shouldn't retry based on "why null".
   */
  getCslByCitationKey(citationKey: string): Promise<unknown | null>;
}
