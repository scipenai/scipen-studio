/**
 * @file BetterBibTexClient — JSON-RPC client for the Better BibTeX plugin
 * @description Better BibTeX (BBT) is a Zotero plugin that exposes a
 *              JSON-RPC endpoint at `localhost:23119/better-bibtex/json-rpc`.
 *              Its main appeal over the plain Zotero Local API is
 *              **human-readable citation keys** (e.g., `smith2024deep`).
 *              See https://retorque.re/zotero-better-bibtex/exporting/json-rpc/.
 *
 *              Lifecycle: BBT requires Zotero to be running with the
 *              plugin enabled. `ping()` is cheap (single noop call) and
 *              is what `ZoteroDiscoveryService` uses to detect presence.
 *
 *              BBT is maintained by a single developer (retorquere). When
 *              it breaks or trails behind a Zotero major release, the
 *              wizard degrades cleanly: callers fall back to the plain
 *              `ZoteroLocalApiClient` + 8-char itemKeys (PM-4 decision).
 */

import { createLogger } from '../LoggerService';

const logger = createLogger('BetterBibTexClient');

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119/better-bibtex/json-rpc';
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

/**
 * BBT JSON-RPC envelope. We follow the v2 dialect (`jsonrpc: '2.0'`),
 * which is what current BBT releases speak.
 */
interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[] | Record<string, unknown>;
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

/**
 * Result of probing the BBT JSON-RPC endpoint. Mirrors
 * `ZoteroPingResultDTO` for symmetry; we keep a local type because BBT's
 * version response shape is different (no major-version header).
 */
export interface BBTPingResult {
  ok: boolean;
  /** BBT plugin version string when reachable. */
  version?: string;
  /** Human-readable failure reason; only set when `ok` is false. */
  error?: string;
}

/** Minimal BBT citation entry shape used by the wizard / index. */
export interface BBTCitationEntry {
  citationKey: string;
  itemKey: string;
  libraryID: number;
}

export class BetterBibTexClient {
  private readonly endpoint: string;
  private requestId = 0;

  constructor(endpoint: string = DEFAULT_BASE_URL) {
    this.endpoint = endpoint;
  }

  /**
   * Cheap reachability probe. We invoke `user.groups` (a side-effect-free
   * lookup) rather than a synthetic noop because BBT does not document a
   * dedicated ping method, and `user.groups` is stable across versions.
   *
   * Errors translate to `{ ok: false, error }` rather than throwing so
   * callers (Wizard / DiscoveryService) can branch without try/catch.
   */
  async ping(): Promise<BBTPingResult> {
    try {
      const result = await this.call<{ version?: string } | string>('user.groups', []);
      // BBT may return either { version, ... } or a plain string depending
      // on plugin version. Either way, a successful response means BBT is up.
      const version =
        typeof result === 'object' && result !== null && 'version' in result
          ? String(result.version)
          : undefined;
      return version !== undefined ? { ok: true, version } : { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('[BBT] ping failed', { error: reason });
      return { ok: false, error: reason };
    }
  }

  /**
   * Free-text search across the BBT-indexed library. Returns entries that
   * carry their human-readable citation key, ready to feed into the @cite
   * dropdown.
   */
  async searchItems(query: string): Promise<BBTCitationEntry[]> {
    if (query.trim().length === 0) {
      return [];
    }
    // BBT's `item.search` returns a tuple-style array per the docs.
    const raw = await this.call<unknown[]>('item.search', [query]);
    return normalizeEntries(raw);
  }

  /**
   * Pull every citation key in the library. Intended for the M1 cold-boot
   * index build in `ZoteroBibIndex` (the Web Worker batch).
   */
  async getAllCitations(): Promise<BBTCitationEntry[]> {
    // BBT exposes `item.citationkey` for bulk citation key dumps. Passing
    // an empty selector returns the entire library.
    const raw = await this.call<unknown[]>('item.citationkey', [[]]);
    return normalizeEntries(raw);
  }

  /**
   * 导出一组 citation key 对应的 BibTeX(默认 BetterBibLaTeX —— UTF-8 友好、
   * 现代字段全)。translator 可传 'BetterBibLaTeX' / 'BetterBibTeX' /
   * 'BibLaTeX' / 'BibTeX' 等 BBT 已注册的 translator 名。
   *
   * `citationKeys` 为空数组时 BBT 返回空字符串(BBT 的行为)。
   */
  async exportBibTex(
    citationKeys: string[],
    translator: string = 'BetterBibLaTeX'
  ): Promise<string> {
    if (citationKeys.length === 0) return '';
    const result = await this.call<string>('item.export', [citationKeys, translator]);
    return typeof result === 'string' ? result : '';
  }

  /**
   * Look up the CSL (Citation Style Language) representation for one
   * citation key. Returns null when the key is unknown.
   */
  async getCslByKey(citationKey: string): Promise<unknown | null> {
    if (!citationKey) return null;
    try {
      const result = await this.call<unknown>('item.export', [[citationKey], 'csljson']);
      return result ?? null;
    } catch (err) {
      logger.debug('getCslByKey failed', {
        citationKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  // ============================================================
  // Internals
  // ============================================================

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.requestId;
    const envelope: JsonRpcEnvelope = { jsonrpc: '2.0', id, method, params };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`BBT JSON-RPC HTTP ${res.status}`);
    }

    const json = (await res.json()) as JsonRpcResponse<T>;
    if ('error' in json) {
      throw new Error(`BBT RPC error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }
}

/**
 * BBT returns heterogeneous shapes — sometimes objects, sometimes tuples
 * `[citationKey, itemKey, libraryID]`. We normalize to a single record
 * type so callers don't have to branch.
 */
function normalizeEntries(raw: unknown[]): BBTCitationEntry[] {
  const out: BBTCitationEntry[] = [];
  if (!Array.isArray(raw)) return out;

  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push({
        citationKey: String(entry[0] ?? ''),
        itemKey: String(entry[1] ?? ''),
        libraryID: typeof entry[2] === 'number' ? entry[2] : 0,
      });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const ck = rec.citationKey ?? rec.citekey ?? rec.key;
      const ik = rec.itemKey ?? rec.zoteroKey ?? rec.id;
      if (ck && ik) {
        out.push({
          citationKey: String(ck),
          itemKey: String(ik),
          libraryID: typeof rec.libraryID === 'number' ? rec.libraryID : 0,
        });
      }
    }
  }
  return out;
}

let singleton: BetterBibTexClient | null = null;

export function getBetterBibTexClient(): BetterBibTexClient {
  if (!singleton) {
    singleton = new BetterBibTexClient();
    logger.info('BetterBibTexClient initialized', { endpoint: singleton.getEndpoint() });
  }
  return singleton;
}
