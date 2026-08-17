/**
 * @file ZoteroLocalDataSource — desktop Zotero + BBT + local PDF backend
 * @description Thin composition over the existing local-mode clients:
 *              - `ZoteroLocalApiClient` for items / annotations / attachments
 *              - `BetterBibTexClient`   for CSL JSON
 *              - `ZoteroFullTextService` for pdf-parse + MinerU tier resolution
 *
 * No new behavior; this class only adapts existing services to the
 * `ZoteroDataSource` interface. All logic is delegated. See
 * `ZoteroDataSource.ts` for why the facade exists.
 */

import type {
  ZoteroAnnotationDTO,
  ZoteroAttachmentDTO,
  ZoteroFullTextResultDTO,
  ZoteroItemDTO,
} from '../../../../shared/types/zotero';
import type { BetterBibTexClient } from './BetterBibTexClient';
import type { ZoteroDataSource, ZoteroDataSourceProbe } from './ZoteroDataSource';
import type { ZoteroFullTextService } from './ZoteroFullTextService';
import type { ZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { createLogger } from '../LoggerService';

const logger = createLogger('ZoteroLocalDataSource');

export interface ZoteroLocalDataSourceDeps {
  localApi: ZoteroLocalApiClient;
  bbt: BetterBibTexClient;
  fullTextService: ZoteroFullTextService;
}

export class ZoteroLocalDataSource implements ZoteroDataSource {
  readonly kind = 'local' as const;

  private readonly localApi: ZoteroLocalApiClient;
  private readonly bbt: BetterBibTexClient;
  private readonly fullTextService: ZoteroFullTextService;

  constructor(deps: ZoteroLocalDataSourceDeps) {
    this.localApi = deps.localApi;
    this.bbt = deps.bbt;
    this.fullTextService = deps.fullTextService;
  }

  async ping(): Promise<ZoteroDataSourceProbe> {
    const result = await this.localApi.ping();
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error ?? 'Zotero Local API unreachable' };
  }

  getAllItems(): Promise<ZoteroItemDTO[]> {
    return this.localApi.getAllItems();
  }

  async getItemAnnotations(itemKey: string): Promise<ZoteroAnnotationDTO[]> {
    if (!itemKey) return [];
    return this.localApi.getItemAnnotations(itemKey);
  }

  async getItemAttachments(itemKey: string): Promise<ZoteroAttachmentDTO[]> {
    if (!itemKey) return [];
    return this.localApi.getItemAttachments(itemKey);
  }

  async getFullText(itemKey: string): Promise<ZoteroFullTextResultDTO> {
    // ZoteroDataSource contract: "Never throws — degrades to
    // { tier: 'none' | 'web_pending', text: '' }". FullTextService can
    // throw on file-system / pdf-parse errors (resolveZoteroDataDir isn't
    // internally guarded); catch here so the facade upholds its contract
    // regardless of downstream behavior — BUT log the swallowed error, else
    // a production bug (pdf-parse crash, sqlite lock, permission) becomes
    // invisible and the LLM only sees "no PDF" without a debug trail.
    try {
      return await this.fullTextService.getFullText(itemKey);
    } catch (err) {
      logger.warn('[Zotero] LocalDataSource.getFullText caught unexpected error', {
        itemKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return { text: '', truncated: false, tier: 'none' };
    }
  }

  async getCslByCitationKey(citationKey: string): Promise<unknown | null> {
    if (!citationKey) return null;
    return this.bbt.getCslByKey(citationKey);
  }
}
