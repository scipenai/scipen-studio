/**
 * @file ZoteroWebDataSource — api.zotero.org backend
 * @description Adapts `ZoteroWebApiClient` to the `ZoteroDataSource` facade.
 *              Two capabilities have no native web-mode implementation:
 *
 *              1. `getFullText` — the PDF is in Zotero cloud storage and
 *                 has not been downloaded locally. Returns the explicit
 *                 `tier: 'web_pending'` sentinel so LLM callers can
 *                 distinguish "unavailable, deferred to stage B" from
 *                 "item has no PDF at all". Stage B is planned to add
 *                 lazy PDF download + LRU cache; this sentinel is the
 *                 hook stage B will overwrite.
 *
 *              2. `getCslByCitationKey` — BBT JSON-RPC only runs on the
 *                 local Zotero client. Returns `null` (matches BBT's own
 *                 "unknown key" answer, downstream cannot mis-branch).
 *
 * The `getItemAnnotations` / `getItemAttachments` capabilities DO work
 * over the Web API — `ZoteroWebApiClient` already implements them (A2
 * commit). No sentinel needed there.
 */

import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroFullTextResultDTO,
  ZoteroItemDTO,
} from '../../../../shared/types/zotero';
import type { ZoteroDataSource, ZoteroDataSourceProbe } from './ZoteroDataSource';
import type { ZoteroWebApiClient } from './ZoteroWebApiClient';

export interface ZoteroWebDataSourceDeps {
  client: ZoteroWebApiClient;
}

export class ZoteroWebDataSource implements ZoteroDataSource {
  readonly kind = 'web' as const;

  private readonly client: ZoteroWebApiClient;

  constructor(deps: ZoteroWebDataSourceDeps) {
    this.client = deps.client;
  }

  async ping(): Promise<ZoteroDataSourceProbe> {
    // ZoteroDataSource contract: "Never throws — errors flatten into
    // { ok: false, error }". WebApiClient.ping is designed never-throws
    // but defensive-in-depth catch closes the contract regardless of
    // downstream drift.
    try {
      const result = await this.client.ping();
      if (result.ok) {
        return {
          ok: true,
          detail: result.username ? `connected as ${result.username}` : undefined,
        };
      }
      return { ok: false, error: result.error ?? 'Zotero Web API unreachable' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getAllItems(): Promise<ZoteroItemDTO[]> {
    return this.client.getAllItems();
  }

  async getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]> {
    if (!itemKey) return [];
    return this.client.getItemAnnotations(itemKey);
  }

  async getItemAttachments(itemKey: string): Promise<ZoteroAttachmentDTO[]> {
    if (!itemKey) return [];
    return this.client.getItemAttachments(itemKey);
  }

  async getFullText(_itemKey: string): Promise<ZoteroFullTextResultDTO> {
    // Web-mode sentinel: PDF full-text extraction is deferred to stage B
    // (lazy download + LRU cache). Callers should treat this as "unavailable
    // in current mode", NOT "item has no PDF" — that distinction matters
    // for the agent's zotero_read tool so the LLM doesn't wrongly claim
    // the paper has no readable content.
    return { text: '', truncated: false, tier: 'web_pending' };
  }

  async getCslByCitationKey(_citationKey: string): Promise<unknown | null> {
    // BBT JSON-RPC only runs against the local Zotero client. Web mode has
    // no equivalent CSL source (Zotero Web API returns bib/citation as
    // rendered HTML, not CSL JSON). Returning `null` matches BBT's own
    // "unknown key" contract, so downstream cannot mis-branch on the shape.
    return null;
  }
}
