/**
 * @file ZoteroLocalApiClient —— 包装对 Zotero Local HTTP API 的调用
 * @description Zotero 7+ 在 `localhost:23119` 提供按需开启的 HTTP 服务,由用户在
 *              Settings → Advanced → "Allow other applications on this
 *              computer to communicate with Zotero" 启用。所有请求打到
 *              `/api/users/0/...` —— `users/0` 段是必需的(省略返回 404)。
 *
 *              三个关键 URL 决策(踩坑后的结论):
 *
 *              1. **endpoint 用 `/items/top` 而非 `/items`** —— Zotero 把
 *                 attachment / annotation / note 也算作 item,如果走 `/items`
 *                 会回来一堆子项垃圾;`/top` 服务端只返顶级,省带宽 + 语义直接。
 *                 但 standalone PDF(用户直接拖进库的裸 PDF)仍是顶级,需客户端
 *                 用 IGNORED_ITEM_TYPES 兜底排除。
 *
 *              2. **`include` 必须含 `data`** —— Zotero `include` 参数是
 *                 "替换"语义,不是"追加"。`include=bib,citation` 会让响应**不含
 *                 `data` 字段**(D-1 的潜伏 bug,直到联调 curl 才暴露)。我们的
 *                 投影完全依赖 data.itemType / data.title / data.creators,所以
 *                 必须显式 `include=data,bib,citation`。
 *
 *              3. **元数据 fallback 到 `meta`** —— Zotero 把渲染过的派生字段
 *                 (creatorSummary / parsedDate)放在 `meta` 而非 `data` 下。
 *                 用户手填条目时 data.creators 可能为空但 meta.creatorSummary
 *                 仍有值(Zotero 反推);year 同理 fallback meta.parsedDate。
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

/** 顶级 endpoint 仍可能放过 standalone attachment / 误入的 note;客户端兜底。 */
const IGNORED_ITEM_TYPES: ReadonlySet<string> = new Set(['attachment', 'annotation', 'note']);

/**
 * Zotero 对无数据 entry 仍渲染一个空 `<div class="csl-bib-body">…</div>` 壳;
 * 真有内容时内部嵌一个 `<div class="csl-entry">`。我们以 csl-entry 的存在
 * 区分"空壳"与"有内容",空壳归一为 undefined 避免污染 IPC。
 */
const BIB_CONTENT_MARKER = 'csl-entry';

export class ZoteroLocalApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 验证 Local API 可达。`ok: false` 时返回人类可读理由 —— 区分 "Zotero 没启动"
   * 与 "Zotero 启动了但 Settings → Advanced 没勾选"。
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
   * 拉一页顶级文献条目,投影为 `ZoteroItemDTO`。调用方用空页作为分页终止信号 ——
   * `Total-Results` header 暂不暴露,真要计数再加。
   */
  async getItems(opts: ZoteroGetItemsOptionsDTO = {}): Promise<ZoteroItemDTO[]> {
    const limit = clampPageSize(opts.limit);
    const start = Math.max(0, opts.start ?? 0);
    const url = `${this.baseUrl}/api/users/0/items/top?format=json&include=data,bib,citation&style=apa&limit=${limit}&start=${start}`;

    const json = await this.fetchJson<ZoteroRawItem[]>(url);

    return (Array.isArray(json) ? json : []).map(toItemDTO).filter(notNull);
  }

  /**
   * 拉取所有顶级条目。`getItems` 按页步进直到空页;`maxPages` 是防御性上限。
   * Renderer 不直接调 —— 走 Orchestrator + EventBus。
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
   * 拉一个父条目下的批注。注意 `include=data` 同样必需,否则 data 字段会缺。
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
   * 拉一个父条目下的附件(走 children,itemType=attachment)。用于定位
   * 论文的 PDF 文件以抽全文。同 annotations,`include=data` 必需。
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
 * 仅类型化我们投影需要的字段。`data` 必含 —— 若上游缺,说明 include 参数错配,
 * 应在 toItemDTO 入口 warn 而非静默 return null(便于联调时定位)。
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
    /** BBT 7+ 注入到 Zotero data schema 的字段 —— 装了 BBT 即可见,无需 JSON-RPC。 */
    citationKey?: string;
    parentItem?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    /** attachment 字段:定位 PDF 文件用。 */
    contentType?: string;
    filename?: string;
    linkMode?: string;
    path?: string;
  };
  /** Zotero 派生字段:creatorSummary / parsedDate / numChildren。 */
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
    // BBT 把 citation key 直接写到 Zotero data schema,LocalApi 顺路就拿到了 ——
    // 不再依赖 BBT JSON-RPC,即便 BBT 的 RPC schema 变化也不影响 ck 可用性。
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
