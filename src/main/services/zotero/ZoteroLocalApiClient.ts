/**
 * @file ZoteroLocalApiClient — wrap calls to Zotero's Local HTTP API
 * @description Zotero 7+ ships an opt-in HTTP server at `localhost:23119`,
 *              enabled by the user via Settings → Advanced → "Allow other
 *              applications on this computer to communicate with Zotero".
 *              All requests target `/api/users/0/...` — the `users/0`
 *              segment is required (omitting it returns 404).
 * @see https://www.zotero.org/support/dev/client_coding/miscellaneous
 */

import type {
  ZoteroAnnotationDTO,
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

export class ZoteroLocalApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Verify the Local API is reachable. Returns `ok: false` with a human-
   * readable reason when Zotero isn't running OR the user hasn't toggled
   * "Allow other applications…" in Advanced settings.
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
        error: isConnRefused
          ? 'Zotero is not running or its Local API is not enabled'
          : reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a single page of Zotero items, projected down to `ZoteroItemDTO`.
   * Callers paginate by advancing `start` until an empty page comes back —
   * we deliberately don't surface the `Total-Results` header here to keep
   * the response shape simple. Switch to a header-aware variant only when
   * a caller actually needs the count.
   *
   * `?include=bib,citation` makes Zotero render CSL formatted HTML inline,
   * sparing us the trip through a separate citation styler. We default
   * the style to APA which matches the wizard's hover-card sample.
   */
  async getItems(opts: ZoteroGetItemsOptionsDTO = {}): Promise<ZoteroItemDTO[]> {
    const limit = clampPageSize(opts.limit);
    const start = Math.max(0, opts.start ?? 0);
    const url =
      `${this.baseUrl}/api/users/0/items` +
      `?format=json&include=bib,citation&style=apa` +
      `&limit=${limit}&start=${start}`;

    const json = await this.fetchJson<ZoteroRawItem[]>(url);

    return (Array.isArray(json) ? json : []).map(toItemDTO).filter(notNull);
  }

  /**
   * Pull every visible top-level item from the Local API. Walks `getItems`
   * in fixed-size pages until an empty page comes back. Used by the
   * bib-index cold boot (方案 D / D-1): renderer never calls this — it
   * goes through the orchestrator + event bus.
   *
   * `maxPages` is a defensive ceiling so a misbehaving Zotero (returning
   * a non-empty page repeatedly) can't pin the main process.
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
   * Fetch annotations attached to one parent item (attachment).
   * Zotero exposes children at `/items/{itemKey}/children` — annotations
   * surface as items whose `itemType === 'annotation'`.
   */
  async getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]> {
    if (!itemKey) return [];
    const url =
      `${this.baseUrl}/api/users/0/items/${encodeURIComponent(itemKey)}/children` +
      `?format=json&itemType=annotation`;
    const raw = await this.fetchJson<ZoteroRawItem[]>(url);
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => toAnnotationDTO(entry, itemKey))
      .filter(notNull);
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

/** Shape Zotero actually emits — we only type the fields we project. */
interface ZoteroRawItem {
  key?: string;
  data?: {
    key?: string;
    itemType?: string;
    title?: string;
    abstractNote?: string;
    date?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
    parentItem?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
  };
  bib?: string;
  citation?: string;
}

function toItemDTO(raw: ZoteroRawItem): ZoteroItemDTO | null {
  const data = raw.data;
  if (!data) return null;
  const itemKey = data.key ?? raw.key ?? '';
  if (!itemKey) return null;

  return {
    itemKey,
    itemType: data.itemType ?? 'unknown',
    title: data.title ?? '',
    creatorsLabel: formatCreators(data.creators),
    year: extractYear(data.date),
    abstractNote: data.abstractNote,
    citation: raw.citation,
    bib: raw.bib,
  };
}

function toAnnotationDTO(
  raw: ZoteroRawItem,
  fallbackParent: string
): ZoteroAnnotationDTO | null {
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
