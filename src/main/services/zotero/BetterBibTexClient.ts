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
   * Export the BibTeX for a set of citation keys (default BetterBibLaTeX —
   * UTF-8 friendly, full modern field set). `translator` accepts any BBT
   * registered translator name: 'BetterBibLaTeX' / 'BetterBibTeX' /
   * 'BibLaTeX' / 'BibTeX'.
   *
   * When `citationKeys` is empty, BBT returns an empty string (BBT's own
   * behaviour).
   */
  async exportBibTex(citationKeys: string[], translator = 'BetterBibLaTeX'): Promise<string> {
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

let singleton: BetterBibTexClient | null = null;

export function getBetterBibTexClient(): BetterBibTexClient {
  if (!singleton) {
    singleton = new BetterBibTexClient();
    logger.info('BetterBibTexClient initialized', { endpoint: singleton.getEndpoint() });
  }
  return singleton;
}
