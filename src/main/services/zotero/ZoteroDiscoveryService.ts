/**
 * @file ZoteroDiscoveryService — detect a local Zotero installation
 * @description Three-stage probe in parallel: (1) ping the Local API —
 *              most reliable, also tells us Zotero is currently running;
 *              (2) ping Better BibTeX's JSON-RPC endpoint to learn
 *              whether human-readable citation keys are available;
 *              (3) walk known per-platform default data-directory paths
 *              for `zotero.sqlite`. Zotero is considered found when (1)
 *              OR (3) succeed; BBT presence is a separate, non-blocking
 *              flag exposed for the M1 wizard's optional step.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import type {
  ZoteroDetectionResultDTO,
  ZoteroWebApiPingResultDTO,
} from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';
import { type BetterBibTexClient, getBetterBibTexClient } from './BetterBibTexClient';
import { type ZoteroLocalApiClient, getZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { ZoteroWebApiClient } from './ZoteroWebApiClient';

const logger = createLogger('ZoteroDiscoveryService');

const ZOTERO_SQLITE = 'zotero.sqlite';

export class ZoteroDiscoveryService {
  constructor(
    private readonly api: ZoteroLocalApiClient = getZoteroLocalApiClient(),
    private readonly bbt: BetterBibTexClient = getBetterBibTexClient()
  ) {}

  async detect(): Promise<ZoteroDetectionResultDTO> {
    // Parallel: cheap network ping + filesystem scan + BBT probe.
    // Each independently times out, so the slowest leg caps total work
    // at roughly 3s (BBT default timeout).
    const [ping, dataDir, bbtPing] = await Promise.all([
      this.api.ping(),
      this.findDataDir(),
      this.bbt.ping(),
    ]);

    if (!ping.ok && !dataDir) {
      return { found: false, betterBibTexInstalled: bbtPing.ok };
    }

    return {
      found: true,
      path: dataDir ?? undefined,
      version: ping.version !== undefined ? String(ping.version) : undefined,
      betterBibTexInstalled: bbtPing.ok,
    };
  }

  private async findDataDir(): Promise<string | null> {
    return resolveZoteroDataDir();
  }

  /**
   * Probe api.zotero.org for a userId + apiKey pair BEFORE committing the
   * key to secure storage. Called by the Settings "Test connection" button
   * so users see instant feedback instead of a silent failure later.
   *
   * Returns a discriminated result: `ok: true` with `username` on success,
   * `ok: false` with a user-friendly `error` categorised by HTTP status
   * (invalid key / user not found / network). Never throws.
   */
  async probeWebApi(userId: string, apiKey: string): Promise<ZoteroWebApiPingResultDTO> {
    if (!userId || !userId.trim()) {
      return { ok: false, error: 'Zotero user ID is required' };
    }
    if (!apiKey || !apiKey.trim()) {
      return { ok: false, error: 'Zotero API key is required' };
    }
    try {
      const client = new ZoteroWebApiClient({ userId: userId.trim(), apiKey: apiKey.trim() });
      return await client.ping();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Probe failed: ${message}` };
    }
  }
}

function zoteroCandidatePaths(): string[] {
  const home = app.getPath('home');
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return [path.join(appData, 'Zotero', 'Zotero'), path.join(home, 'Zotero')];
    }
    case 'darwin':
      return [
        path.join(home, 'Zotero'),
        path.join(home, 'Library', 'Application Support', 'Zotero'),
      ];
    default:
      return [path.join(home, 'Zotero'), path.join(home, '.zotero', 'zotero')];
  }
}

/**
 * Locate the Zotero data directory (the one containing `zotero.sqlite`).
 * Attachments live under `{dataDir}/storage/{attachmentKey}/`. Shared by
 * discovery probing and full-text extraction.
 */
export async function resolveZoteroDataDir(): Promise<string | null> {
  for (const dir of zoteroCandidatePaths()) {
    if (await fileExists(path.join(dir, ZOTERO_SQLITE))) {
      logger.debug('Found Zotero data dir', { dir });
      return dir;
    }
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let singleton: ZoteroDiscoveryService | null = null;

export function getZoteroDiscoveryService(): ZoteroDiscoveryService {
  if (!singleton) {
    singleton = new ZoteroDiscoveryService();
  }
  return singleton;
}
