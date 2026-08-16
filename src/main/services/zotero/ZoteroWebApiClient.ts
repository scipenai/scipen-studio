/**
 * @file ZoteroWebApiClient — wraps calls to zotero.org's Web API v3.
 * @description Cloud counterpart to ZoteroLocalApiClient. Mirrors the same
 *              method shape (`ping` / `getItems` / `getAllItems` /
 *              `getItemAnnotations` / `getItemAttachments`) so
 *              ZoteroOrchestrator can swap them via a single `dataSource`
 *              branch — no state-machine or EventBus changes.
 *
 *              Wire differences vs LocalApi:
 *              1. **baseUrl** — `https://api.zotero.org` (public HTTPS)
 *              2. **auth** — `Zotero-API-Key` header (SecureStorage-backed)
 *              3. **version** — `Zotero-API-Version: 3` header (pins schema
 *                 semantics; upstream may bump)
 *              4. **path prefix** — `/users/{userID}/...` (numeric userID),
 *                 not the `/api/users/0/...` LocalApi shorthand
 *              5. **rate limit** — 429 with `Retry-After` header; enforced
 *                 with bounded retry loop
 *              6. **5xx** — one backoff retry (transient cloud hiccups)
 *
 *              The `include=data,bib,citation` gotcha, IGNORED_ITEM_TYPES
 *              filter and empty csl-bib-body shell semantics are IDENTICAL
 *              to LocalApi (Zotero API v3 spec is single-source), so the
 *              projection helpers here mirror LocalApiClient exactly and
 *              MUST stay in sync when either side changes.
 *
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 */

import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroGetItemsOptionsDTO,
  ZoteroItemDTO,
  ZoteroWebApiPingResultDTO,
} from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';

const logger = createLogger('ZoteroWebApiClient');

export const DEFAULT_WEB_API_BASE = 'https://api.zotero.org';
const ZOTERO_API_VERSION = '3';
const DEFAULT_PING_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 2000;
const MAX_RETRY_AFTER_MS = 60_000;
const SERVER_ERROR_BACKOFF_MS = 500;

/** Keep in sync with ZoteroLocalApiClient.IGNORED_ITEM_TYPES. */
const IGNORED_ITEM_TYPES: ReadonlySet<string> = new Set(['attachment', 'annotation', 'note']);

/** Empty-shell marker, identical to LocalApi (Zotero renders same envelope). */
const BIB_CONTENT_MARKER = 'csl-entry';

export interface ZoteroWebApiClientOptions {
  userId: string;
  apiKey: string;
  baseUrl?: string;
  /** Override request timeout (ms) — mostly for tests. */
  requestTimeoutMs?: number;
  /** Override ping timeout (ms) — mostly for tests. */
  pingTimeoutMs?: number;
}

export class ZoteroWebApiClient {
  private readonly userId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly pingTimeoutMs: number;

  constructor(opts: ZoteroWebApiClientOptions) {
    if (!opts.userId) {
      throw new Error('ZoteroWebApiClient requires a non-empty userId');
    }
    if (!opts.apiKey) {
      throw new Error('ZoteroWebApiClient requires a non-empty apiKey');
    }
    this.userId = opts.userId;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_WEB_API_BASE).replace(/\/+$/, '');
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  }

  /**
   * Verify credentials + endpoint reachability. Classified errors:
   *   401 → "invalid API key"
   *   403 → "API key lacks permission"
   *   404 → "user not found"
   *   timeout/network → "cannot reach api.zotero.org"
   * Uses `/users/{userID}/items?limit=1` — cheapest read that exercises auth.
   */
  async ping(): Promise<ZoteroWebApiPingResultDTO> {
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.userId)}/items?limit=1&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.pingTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.authHeaders(),
      });
      if (res.status === 401) return { ok: false, error: 'API key invalid or expired' };
      if (res.status === 403) return { ok: false, error: 'API key lacks required permissions' };
      if (res.status === 404) return { ok: false, error: 'Zotero user ID not found' };
      if (res.status === 429)
        return { ok: false, error: 'Rate limited by Zotero API; try again shortly' };
      if (!res.ok) return { ok: false, error: `Zotero Web API returned HTTP ${res.status}` };
      // Fetch username from /users/{userID} for UI display; treat missing profile as ok+anonymous.
      const username = await this.fetchUsername();
      return username ? { ok: true, username } : { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isNetwork = /aborted|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(reason);
      return {
        ok: false,
        error: isNetwork ? 'Cannot reach api.zotero.org (network or DNS issue)' : reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch one page of top-level items, projected to ZoteroItemDTO. Mirrors
   * LocalApi's `include=data,bib,citation` contract. `bib` HTML is expensive
   * to compute server-side but essential for cite-preview UX.
   */
  async getItems(opts: ZoteroGetItemsOptionsDTO = {}): Promise<ZoteroItemDTO[]> {
    const limit = clampPageSize(opts.limit);
    const start = Math.max(0, opts.start ?? 0);
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.userId)}/items/top?format=json&include=data,bib,citation&style=apa&limit=${limit}&start=${start}`;
    const json = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(json) ? json : []).map(toItemDTO).filter(notNull);
  }

  /**
   * Paginate until an empty page or `maxPages` guard trips. Web API caps
   * pages at 100 items each, same as LocalApi.
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

  async getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]> {
    if (!itemKey) return [];
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.userId)}/items/${encodeURIComponent(itemKey)}/children?format=json&include=data&itemType=annotation`;
    const raw = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => toAnnotationDTO(entry, itemKey))
      .filter(notNull);
  }

  async getItemAttachments(itemKey: string): Promise<ZoteroAttachmentDTO[]> {
    if (!itemKey) return [];
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.userId)}/items/${encodeURIComponent(itemKey)}/children?format=json&include=data&itemType=attachment`;
    const raw = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(raw) ? raw : []).map((entry) => toAttachmentDTO(entry)).filter(notNull);
  }

  getUserId(): string {
    return this.userId;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ============================================================
  // Internals
  // ============================================================

  private authHeaders(): Record<string, string> {
    return {
      'Zotero-API-Key': this.apiKey,
      'Zotero-API-Version': ZOTERO_API_VERSION,
      Accept: 'application/json',
    };
  }

  /**
   * GET a JSON endpoint with rate-limit + transient 5xx retry. Retry budget
   * is per-call, not per-client, so a long batch job that keeps hitting
   * 429 fails each request individually rather than starving the whole
   * fetch loop.
   */
  private async fetchJson<T>(url: string): Promise<T> {
    let lastError: unknown = null;
    let serverRetried = false;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: this.authHeaders() });
        if (res.status === 429) {
          if (attempt >= RATE_LIMIT_MAX_RETRIES) {
            throw new Error('Zotero Web API rate-limited (retry budget exhausted)');
          }
          const delay = parseRetryAfter(res.headers) ?? DEFAULT_RETRY_AFTER_MS;
          logger.warn('[Zotero] Web API 429; backing off', { url, delayMs: delay, attempt });
          await sleep(delay);
          continue;
        }
        if (res.status >= 500 && res.status <= 599 && !serverRetried) {
          // Bounded by attempt budget too: if we're already on the last attempt,
          // there's no room to try again — surface the 5xx immediately instead
          // of `continue`-ing out of the loop and throwing a bare
          // "Error('null')" from the fallback below.
          if (attempt >= RATE_LIMIT_MAX_RETRIES) {
            throw new Error(`Zotero Web API HTTP ${res.status} (retry budget exhausted)`);
          }
          serverRetried = true;
          logger.warn('[Zotero] Web API 5xx; single backoff retry', { url, status: res.status });
          await sleep(SERVER_ERROR_BACKOFF_MS);
          continue;
        }
        if (!res.ok) {
          throw new Error(`Zotero Web API HTTP ${res.status}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        // AbortError from a per-attempt timeout is retryable if we still have budget;
        // network-level errors bubble out immediately so callers can surface them.
        const isAbort = err instanceof Error && /aborted/i.test(err.message);
        if (!isAbort) throw err;
        if (attempt >= RATE_LIMIT_MAX_RETRIES) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    // Reaching here means the loop exhausted its budget without either
    // returning JSON or throwing — should not happen with the 5xx guard
    // above, but keep a readable fallback rather than "Error('null')".
    if (lastError instanceof Error) throw lastError;
    throw new Error('Zotero Web API fetch exhausted retry budget without a definitive response');
  }

  private async fetchUsername(): Promise<string | undefined> {
    try {
      const url = `${this.baseUrl}/users/${encodeURIComponent(this.userId)}?format=json`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.pingTimeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: this.authHeaders() });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { username?: unknown; name?: unknown };
        if (typeof body.username === 'string' && body.username.length > 0) return body.username;
        if (typeof body.name === 'string' && body.name.length > 0) return body.name;
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    }
  }
}

// ============================================================
// Projection helpers — kept in lockstep with ZoteroLocalApiClient.
// If Zotero API v3 semantics change, update BOTH files.
// ============================================================

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : 0;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPageSize(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
}

interface ZoteroRawItem {
  key?: string;
  data?: {
    key?: string;
    itemType?: string;
    title?: string;
    abstractNote?: string;
    date?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
    citationKey?: string;
    parentItem?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    contentType?: string;
    filename?: string;
    linkMode?: string;
    path?: string;
  };
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
    logger.warn('Zotero Web API raw item missing `data` — check include= param', {
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
