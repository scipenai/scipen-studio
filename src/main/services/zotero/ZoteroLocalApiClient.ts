/**
 * @file ZoteroLocalApiClient — wraps calls to the Zotero Local HTTP API.
 * @description Zotero 7+ exposes an opt-in HTTP service at `localhost:23119`,
 *              enabled by the user via Settings -> Advanced -> "Allow other
 *              applications on this computer to communicate with Zotero". All
 *              requests hit `/api/users/0/...` — the `users/0` segment is
 *              required (omitting it returns 404).
 *
 *              Three critical URL decisions (lessons learned the hard way):
 *
 *              1. **Use `/items/top` endpoint, not `/items`** — Zotero treats
 *                 attachment / annotation / note as items too. `/items` returns
 *                 a flood of child junk; `/top` only returns top-level entries
 *                 server-side, saving bandwidth and being semantically direct.
 *                 Standalone PDFs (raw PDFs dragged straight into the library)
 *                 are still top-level, so the client must also filter via
 *                 IGNORED_ITEM_TYPES as a safety net.
 *
 *              2. **`include` must contain `data`** — Zotero's `include` param
 *                 has "replace" semantics, not "append". `include=bib,citation`
 *                 yields a response **without `data`** (a latent D-1 bug that
 *                 only surfaced during curl debugging). Our projection depends
 *                 entirely on data.itemType / data.title / data.creators, so
 *                 we must pass `include=data,bib,citation` explicitly.
 *
 *              3. **Metadata fallback to `meta`** — Zotero stores rendered
 *                 derived fields (creatorSummary / parsedDate) under `meta`
 *                 rather than `data`. For manually entered items, data.creators
 *                 may be empty while meta.creatorSummary still has a value
 *                 (Zotero infers it); year similarly falls back to
 *                 meta.parsedDate.
 *
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 */

import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroGetItemsOptionsDTO,
  ZoteroItemDTO,
  ZoteroPingResultDTO,
} from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';

const logger = createLogger('ZoteroLocalApiClient');

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';
const DEFAULT_PING_TIMEOUT_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/** Top-level endpoint may still leak standalone attachments / stray notes; client-side safety net. */
const IGNORED_ITEM_TYPES: ReadonlySet<string> = new Set(['attachment', 'annotation', 'note']);

/**
 * Zotero renders an empty `<div class="csl-bib-body">…</div>` shell even for
 * entries with no data; real content nests a `<div class="csl-entry">` inside.
 * We use the presence of csl-entry to distinguish "empty shell" from "has
 * content" and normalize the shell to undefined to avoid polluting IPC.
 */
const BIB_CONTENT_MARKER = 'csl-entry';

export class ZoteroLocalApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Verify Local API reachability. On `ok: false`, return a human-readable
   * reason — distinguish "Zotero not running" from "Zotero running but
   * Settings -> Advanced checkbox not enabled".
   */
  async ping(): Promise<ZoteroPingResultDTO> {
    const url = `${this.baseUrl}/api/users/0/items?limit=1&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_PING_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) {
        return {
          ok: false,
          error: `Zotero Local API returned HTTP ${res.status}`,
        };
      }

      const version = parseMajorVersion(res.headers);
      return version !== null ? { ok: true, version } : { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isConnRefused = /ECONNREFUSED|fetch failed|aborted/i.test(reason);
      return {
        ok: false,
        error: isConnRefused ? 'Zotero is not running or its Local API is not enabled' : reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch one page of top-level bibliography items, projected to `ZoteroItemDTO`.
   * Callers use an empty page as the pagination terminator — `Total-Results`
   * header is not exposed yet; add counting only if actually needed.
   */
  async getItems(opts: ZoteroGetItemsOptionsDTO = {}): Promise<ZoteroItemDTO[]> {
    const limit = clampPageSize(opts.limit);
    const start = Math.max(0, opts.start ?? 0);
    const url = `${this.baseUrl}/api/users/0/items/top?format=json&include=data,bib,citation&style=apa&limit=${limit}&start=${start}`;

    const json = await this.fetchJson<ZoteroRawItem[]>(url);

    return (Array.isArray(json) ? json : []).map(toItemDTO).filter(notNull);
  }

  /**
   * Fetch all top-level items. `getItems` paginates until an empty page;
   * `maxPages` is a defensive upper bound. Renderer must not call directly —
   * go through Orchestrator + EventBus.
   */
  async getAllItems(maxPages = 200): Promise<ZoteroItemDTO[]> {
    const out: ZoteroItemDTO[] = [];
    let start = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.getItems({ start, limit: MAX_PAGE_SIZE });
      if (batch.length === 0) break;
      out.push(...batch);
      if (batch.length < MAX_PAGE_SIZE) break;
      start += batch.length;
    }
    return out;
  }

  /**
   * Fetch annotations under a parent item. Note `include=data` is again
   * required, otherwise the data field is missing.
   */
  async getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]> {
    if (!itemKey) return [];
    const url = `${this.baseUrl}/api/users/0/items/${encodeURIComponent(itemKey)}/children?format=json&include=data&itemType=annotation`;
    const raw = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => toAnnotationDTO(entry, itemKey))
      .filter(notNull);
  }

  /**
   * Fetch attachments under a parent item (via children, itemType=attachment).
   * Used to locate the paper's PDF for full-text extraction. Like annotations,
   * `include=data` is required.
   */
  async getItemAttachments(itemKey: string): Promise<ZoteroAttachmentDTO[]> {
    if (!itemKey) return [];
    const url = `${this.baseUrl}/api/users/0/items/${encodeURIComponent(itemKey)}/children?format=json&include=data&itemType=attachment`;
    const raw = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(raw) ? raw : []).map((entry) => toAttachmentDTO(entry)).filter(notNull);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ============================================================
  // Internals
  // ============================================================

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Zotero Local API HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================
// Header / payload normalization helpers
// ============================================================

function parseMajorVersion(headers: Headers): number | null {
  const candidates = [
    headers.get('Zotero-Schema-Version'),
    headers.get('X-Zotero-Version'),
    headers.get('Server'),
  ];
  for (const value of candidates) {
    if (!value) continue;
    const match = value.match(/(\d+)/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n >= 7 && n <= 99) return n;
    }
  }
  return null;
}

function clampPageSize(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
}

/**
 * Only types the fields our projection needs. `data` must be present — if
 * upstream is missing it, the include= param is misconfigured, so warn at
 * toItemDTO entry rather than silently returning null (helps debugging).
 */
interface ZoteroRawItem {
  key?: string;
  data?: {
    key?: string;
    itemType?: string;
    title?: string;
    abstractNote?: string;
    date?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
    /** Field injected by BBT 7+ into the Zotero data schema — visible whenever BBT is installed, no JSON-RPC needed. */
    citationKey?: string;
    parentItem?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    /** Attachment fields: used to locate the PDF file. */
    contentType?: string;
    filename?: string;
    linkMode?: string;
    path?: string;
  };
  /** Zotero derived fields: creatorSummary / parsedDate / numChildren. */
  meta?: {
    creatorSummary?: string;
    parsedDate?: string;
    numChildren?: number;
  };
  bib?: string;
  citation?: string;
}

function toItemDTO(raw: ZoteroRawItem): ZoteroItemDTO | null {
  if (!raw.data) {
    logger.warn('Zotero raw item missing `data` field — check include= param', {
      key: raw.key,
    });
    return null;
  }
  const data = raw.data;
  const itemKey = data.key ?? raw.key ?? '';
  if (!itemKey) return null;

  const itemType = data.itemType ?? 'unknown';
  if (IGNORED_ITEM_TYPES.has(itemType)) return null;

  return {
    itemKey,
    itemType,
    title: data.title ?? '',
    creatorsLabel: formatCreators(data.creators) ?? raw.meta?.creatorSummary,
    year: extractYear(data.date) ?? extractYear(raw.meta?.parsedDate),
    // BBT writes the citation key directly into the Zotero data schema, so
    // LocalApi picks it up for free — no longer dependent on BBT JSON-RPC,
    // so BBT RPC schema churn does not break ck availability.
    citationKey: data.citationKey || undefined,
    abstractNote: data.abstractNote,
    citation: normalizeCitation(raw.citation),
    bib: normalizeBib(raw.bib),
  };
}

function toAnnotationDTO(raw: ZoteroRawItem, fallbackParent: string): ZoteroAnnotationDTO | null {
  const data = raw.data;
  if (!data) return null;
  const itemKey = data.key ?? raw.key ?? '';
  if (!itemKey) return null;
  if (data.annotationType === undefined) return null;

  return {
    itemKey,
    parentItemKey: data.parentItem ?? fallbackParent,
    annotationType: data.annotationType,
    annotationText: data.annotationText,
    annotationComment: data.annotationComment,
    annotationColor: data.annotationColor,
    annotationPageLabel: data.annotationPageLabel,
  };
}

function toAttachmentDTO(raw: ZoteroRawItem): ZoteroAttachmentDTO | null {
  const data = raw.data;
  if (!data) return null;
  const itemKey = data.key ?? raw.key ?? '';
  if (!itemKey) return null;
  return {
    itemKey,
    contentType: data.contentType,
    filename: data.filename,
    linkMode: data.linkMode,
    path: data.path,
  };
}

function formatCreators(
  creators?: Array<{ firstName?: string; lastName?: string; name?: string }>
): string | undefined {
  if (!creators || creators.length === 0) return undefined;
  const names = creators
    .map((c) => c.lastName ?? c.name ?? c.firstName ?? '')
    .filter((n) => n.length > 0);
  if (names.length === 0) return undefined;
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} et al.`;
}

function extractYear(date?: string): number | undefined {
  if (!date) return undefined;
  const m = date.match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

function normalizeBib(bib?: string): string | undefined {
  if (!bib) return undefined;
  return bib.includes(BIB_CONTENT_MARKER) ? bib : undefined;
}

function normalizeCitation(citation?: string): string | undefined {
  if (!citation || citation.trim().length === 0) return undefined;
  return citation;
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

let singleton: ZoteroLocalApiClient | null = null;

export function getZoteroLocalApiClient(): ZoteroLocalApiClient {
  if (!singleton) {
    singleton = new ZoteroLocalApiClient();
    logger.info('ZoteroLocalApiClient initialized', { baseUrl: singleton.getBaseUrl() });
  }
  return singleton;
}
