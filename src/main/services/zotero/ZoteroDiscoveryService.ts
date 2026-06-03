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
import type { ZoteroDetectionResultDTO } from '../../../../shared/types/zotero';
import { createLogger } from '../LoggerService';
import { type BetterBibTexClient, getBetterBibTexClient } from './BetterBibTexClient';
import { type ZoteroLocalApiClient, getZoteroLocalApiClient } from './ZoteroLocalApiClient';

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
 * 找 Zotero 数据目录(含 `zotero.sqlite` 的那个)。附件存储在
 * `{dataDir}/storage/{attachmentKey}/`。Discovery 探测与全文抽取共用。
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
