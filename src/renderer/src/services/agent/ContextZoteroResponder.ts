/**
 * @file ContextZoteroResponder — renderer side of the SNACA
 *   reverse-RPC for Zotero-backed context kinds.
 *
 * Three kinds, all wired here:
 *   - `zotero_search`      → ZoteroBibIndex.search()
 *   - `zotero_lookup`      → ZoteroBibIndex.get/getByCitationKey + getCsl
 *   - `zotero_annotations` → api.zotero.getItemAnnotations()
 *
 * The host (main process) parks the request with a 5s timeout, so
 * partial / failed answers are fine — we always send *some* response
 * within budget. Empty arrays are valid; we only signal `ok: false` for
 * exceptional cases (e.g. the index hasn't been wired up at all and
 * even `ensureLoaded` rejected).
 */

import { agentClient } from './AgentClientService';
import { api } from '../../api';
import { createLogger } from '../LogService';
import { getZoteroBibIndex } from '../zotero/ZoteroBibIndex';

const logger = createLogger('ContextZoteroResponder');

/** Default top-N for `zotero_search` when caller omits `limit`. */
const DEFAULT_SEARCH_LIMIT = 10;
/** Hard cap matching the host-side schema (max 50). */
const MAX_SEARCH_LIMIT = 50;

interface InboundRequest {
  requestId: string;
  kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations';
  params: Record<string, unknown>;
}

export class ContextZoteroResponder {
  private offUnsubscribe: (() => void) | null = null;

  start(): void {
    if (this.offUnsubscribe) return;
    this.offUnsubscribe = agentClient.onContextZoteroRequest((req) => {
      void this.dispatch(req).catch((err) => {
        logger.error('handler threw — replying error', {
          requestId: req.requestId,
          kind: req.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        // Best-effort fallback: respond ok:false so SNACA doesn't hang.
        agentClient
          .respondContextZotero({
            requestId: req.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
          .catch((respondErr) => {
            logger.warn('fallback respondContextZotero failed', {
              requestId: req.requestId,
              error:
                respondErr instanceof Error ? respondErr.message : String(respondErr),
            });
          });
      });
    });
  }

  stop(): void {
    this.offUnsubscribe?.();
    this.offUnsubscribe = null;
  }

  private async dispatch(req: InboundRequest): Promise<void> {
    switch (req.kind) {
      case 'zotero_search':
        await this.handleSearch(req);
        return;
      case 'zotero_lookup':
        await this.handleLookup(req);
        return;
      case 'zotero_annotations':
        await this.handleAnnotations(req);
        return;
    }
  }

  // ============ Per-kind handlers ============

  private async handleSearch(req: InboundRequest): Promise<void> {
    const query = typeof req.params.query === 'string' ? req.params.query : '';
    const rawLimit = req.params.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(rawLimit)))
        : DEFAULT_SEARCH_LIMIT;

    const bib = getZoteroBibIndex();
    await bib.ensureLoaded();
    const hits = await bib.search(query, limit);

    await agentClient.respondContextZotero({
      requestId: req.requestId,
      ok: true,
      data: {
        results: hits.map((h) => ({
          item_key: h.itemKey,
          citation_key: h.citationKey,
          title: h.title,
          creators_label: h.creatorsLabel,
          year: h.year,
          score: h.score,
        })),
      },
    });
  }

  private async handleLookup(req: InboundRequest): Promise<void> {
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (!key) {
      await agentClient.respondContextZotero({
        requestId: req.requestId,
        ok: false,
        error: 'missing `key` param',
      });
      return;
    }

    const bib = getZoteroBibIndex();
    await bib.ensureLoaded();
    const entry = bib.getByCitationKey(key) ?? bib.get(key);

    if (!entry) {
      await agentClient.respondContextZotero({
        requestId: req.requestId,
        ok: true,
        data: { found: false },
      });
      return;
    }

    // Best-effort CSL fetch — getCsl is BBT-only and may return null
    // when BBT isn't installed; that's fine, we just omit it.
    let csl: unknown = undefined;
    if (entry.citationKey) {
      try {
        csl = (await api.zotero.getCslByKey(entry.citationKey)) ?? undefined;
      } catch {
        // Swallow — CSL is optional metadata.
      }
    }

    await agentClient.respondContextZotero({
      requestId: req.requestId,
      ok: true,
      data: {
        found: true,
        item: {
          item_key: entry.itemKey,
          citation_key: entry.citationKey,
          title: entry.title,
          creators_label: entry.creatorsLabel,
          year: entry.year,
          // `abstract` isn't on BibIndexEntry — it lives only in the
          // LocalAPI projection. M2 will fold the hover-card abstract
          // into the cache; until then we omit.
          csl,
        },
      },
    });
  }

  private async handleAnnotations(req: InboundRequest): Promise<void> {
    const itemKey = typeof req.params.item_key === 'string' ? req.params.item_key : '';
    if (!itemKey) {
      await agentClient.respondContextZotero({
        requestId: req.requestId,
        ok: false,
        error: 'missing `item_key` param',
      });
      return;
    }

    const annotations = await api.zotero.getItemAnnotations(itemKey);
    await agentClient.respondContextZotero({
      requestId: req.requestId,
      ok: true,
      data: {
        annotations: annotations.map((a) => ({
          item_key: a.itemKey,
          parent_item_key: a.parentItemKey,
          annotation_type: a.annotationType,
          text: a.annotationText,
          comment: a.annotationComment,
          color: a.annotationColor,
          page_label: a.annotationPageLabel,
        })),
      },
    });
  }
}

let singleton: ContextZoteroResponder | null = null;

export function getContextZoteroResponder(): ContextZoteroResponder {
  if (!singleton) singleton = new ContextZoteroResponder();
  return singleton;
}
