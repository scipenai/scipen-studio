/**
 * @file ContextZoteroResponder — renderer side of the SNACA reverse-RPC
 *   for Zotero-backed context kinds.
 *
 * Three kinds, all wired here:
 *   - `zotero_search`      → ZoteroBibMirror.searchByQueryWithScore()
 *   - `zotero_lookup`      → ZoteroBibMirror.getByCitationKey() / getByItemKey() + getCsl
 *   - `zotero_annotations` → api.zotero.getItemAnnotations()
 *
 * Host (main process) parks the request with a 5s timeout, so partial /
 * failed answers are fine — we always send *some* response within budget.
 * Empty arrays are valid; `ok: false` only on exceptional errors.
 *
 * Local notes vs upstream c38298d port:
 *   Upstream used `ZoteroBibIndex` Worker. Local uses main canonical +
 *   `ZoteroBibMirror` (renderer mirror). Mirror lifecycle is App-level
 *   via `useZoteroMirrorLifecycle`; no `ensureLoaded` here. If mirror
 *   isn't ready yet (cold boot), search/lookup return empty — the LLM
 *   sees "no results", which is the right behaviour during warm-up.
 */

import { agentClient } from './AgentClientService';
import { api } from '../../api';
import { createLogger } from '../LogService';
import { getZoteroBibMirror } from '../zotero/ZoteroBibMirror';

const logger = createLogger('ContextZoteroResponder');

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

interface InboundRequest {
  requestId: string;
  kind: 'zotero_search' | 'zotero_lookup' | 'zotero_annotations' | 'zotero_read';
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
        agentClient
          .respondContextZotero({
            requestId: req.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
          .catch((respondErr) => {
            logger.warn('fallback respondContextZotero failed', {
              requestId: req.requestId,
              error: respondErr instanceof Error ? respondErr.message : String(respondErr),
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
      case 'zotero_read':
        await this.handleRead(req);
        return;
    }
  }

  private async handleSearch(req: InboundRequest): Promise<void> {
    const query = typeof req.params.query === 'string' ? req.params.query : '';
    const rawLimit = req.params.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(rawLimit)))
        : DEFAULT_SEARCH_LIMIT;

    const hits = getZoteroBibMirror().searchByQueryWithScore(query, limit);

    await agentClient.respondContextZotero({
      requestId: req.requestId,
      ok: true,
      data: {
        results: hits.map((h) => ({
          item_key: h.item.itemKey,
          citation_key: h.item.citationKey,
          title: h.item.title,
          creators_label: h.item.creatorsLabel,
          year: h.item.year,
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

    const mirror = getZoteroBibMirror();
    const entry = mirror.getByCitationKey(key) ?? mirror.getByItemKey(key);

    if (!entry) {
      // Mirror miss = key is not in the currently-hydrated canonical set. In
      // web mode the mirror IS the canonical set (orchestrator hydrated from
      // api.zotero.org), so this usually means the item genuinely doesn't
      // exist. But mirrors can be stale (window opened before a cloud add /
      // refresh cooldown suppressed the last poll), so:
      //   1. Emit `reason` in the response — LLM can distinguish "no such
      //      item" from "possibly stale snapshot, try again after refresh".
      //   2. Fire-and-forget trigger a refresh so a follow-up call has a
      //      chance to hit. Cooldown inside the orchestrator gates real work.
      // Extending to real backend lookup (via a new IPC handler + facade
      // capability, so we can single-item-fetch the key from local/web
      // backend directly) is stage B/C work — needed alongside group-library
      // support so lookup crosses libraries too. For stage A, honest signal
      // + refresh nudge is the minimal correct answer.
      logger.warn('lookup mirror miss — triggering refresh', { key });
      void api.zotero.requestRefresh().catch(() => undefined);
      await agentClient.respondContextZotero({
        requestId: req.requestId,
        ok: true,
        data: {
          found: false,
          reason: 'mirror_miss_at_current_snapshot',
        },
      });
      return;
    }

    let csl: unknown = undefined;
    if (entry.citationKey) {
      try {
        csl = (await api.zotero.getCslByKey(entry.citationKey)) ?? undefined;
      } catch {
        // CSL is optional metadata; failure is non-fatal.
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
          abstract: entry.abstractNote,
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

  private async handleRead(req: InboundRequest): Promise<void> {
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (!key) {
      await agentClient.respondContextZotero({
        requestId: req.requestId,
        ok: false,
        error: 'missing `key` param',
      });
      return;
    }

    // Normalise citationKey → itemKey via mirror (full-text extraction is
    // keyed by itemKey). On mirror miss (stale mirror / cross-mode key
    // mismatch / never-cached item) fall through with the raw key rather
    // than hardcoded 'none' return — the main-side handler + data-source
    // facade owns the honest answer for each mode:
    //   - local mode: FullTextService → 'none' if no PDF (accurate)
    //   - web mode:   ZoteroWebDataSource → 'web_pending' sentinel (accurate)
    // A previous version short-circuited with 'none' here, which
    // silently under-reported web-mode capability and masked stale-mirror
    // problems as "no PDF".
    //
    // On mirror miss, delegate raw key to handler + emit `reason:'unresolved_key'`
    // so downstream (SNACA → LLM) can distinguish "genuine no PDF" from
    // "gave the tool a key we couldn't map to an item". The LLM can then
    // retry with a canonical key rather than concluding the paper has no
    // readable content.
    //
    // Key subtlety: reason is a **tier='none' disambiguator only**. If the
    // raw key happened to be a valid itemKey and getFullText returned real
    // text (`tier:'local'|'mineru'`) or the web-mode sentinel
    // (`tier:'web_pending'`), emitting `reason:'unresolved_key'` alongside
    // would give the LLM contradictory signals (valid text + "key unresolved"
    // makes no sense). So only attach reason when the tier actually needs
    // disambiguation — i.e. `tier === 'none'`.
    const mirror = getZoteroBibMirror();
    const entry = mirror.getByCitationKey(key) ?? mirror.getByItemKey(key);
    const itemKey = entry?.itemKey ?? key;

    const result = await api.zotero.getFullText(itemKey);
    const reason = !entry && result.tier === 'none' ? 'unresolved_key' : undefined;
    await agentClient.respondContextZotero({
      requestId: req.requestId,
      ok: true,
      data: {
        text: result.text,
        truncated: result.truncated,
        tier: result.tier,
        quality: result.quality,
        reason,
      },
    });
  }
}

let singleton: ContextZoteroResponder | null = null;

export function getContextZoteroResponder(): ContextZoteroResponder {
  if (!singleton) singleton = new ContextZoteroResponder();
  return singleton;
}
