/**
 * @file ZoteroFullTextService — on-demand extract Zotero paper PDFs into
 *   plain body text for the LLM's `zotero_read` reverse RPC to pull (text
 *   source tier 1: local pdf-parse).
 *
 * Pipeline: itemKey -> LocalApi query PDF attachment -> resolve local file
 * path -> pdf-parse extract text -> write global cache at
 * `~/.scipen-studio/zotero-cache/<itemKey>/`. Cache is keyed by itemKey
 * (papers belong to the library, shared across projects); mtime + size act
 * as a cheap invalidation guard.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import type { ZoteroFullTextResultDTO } from '../../../../shared/types/zotero';
import type { MinerUContentList } from '../../../../shared/types/zotero-mineru';
import { truncateToBytes } from '../../../../shared/utils';
import { createLogger } from '../LoggerService';
import { getZoteroLocalApiClient, type ZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { resolveZoteroDataDir } from './ZoteroDiscoveryService';

const logger = createLogger('ZoteroFullTextService');

/** Per-paper return cap, aligned with AtMentionResolver's @file cap (truncate + flag beyond). */
const MAX_TEXT_BYTES = 200 * 1024;

/** Global paper cache root (cross-project, keyed by itemKey). Shared by MinerU parse outputs and full-text extraction. */
export const ZOTERO_CACHE_ROOT = path.join(os.homedir(), '.scipen-studio', 'zotero-cache');

/** Per-item cache dir `<root>/<itemKey>/`. itemKey is 8 chars [A-Z0-9], safe as a directory name. */
export function zoteroItemCacheDir(itemKey: string): string {
  return path.join(ZOTERO_CACHE_ROOT, itemKey);
}

/** MinerU parse output dir `<itemKey>/parsed/` (full.md + content_list.json + images). */
export function zoteroParsedDir(itemKey: string): string {
  return path.join(zoteroItemCacheDir(itemKey), 'parsed');
}

interface CacheMeta {
  /** Source PDF absolute path. */
  pdfPath: string;
  /** Cheap invalidation guard: any change in PDF mtime or size triggers re-extract. */
  pdfMtimeMs: number;
  pdfSize: number;
  extractedAt: string;
}

export class ZoteroFullTextService {
  constructor(private readonly api: ZoteroLocalApiClient = getZoteroLocalApiClient()) {}

  /**
   * Fetch a paper's plain body text. No PDF attachment -> `tier:'none'`;
   * success -> `tier:'local'`. Cache hit (PDF unchanged) skips pdf-parse;
   * truncated to `MAX_TEXT_BYTES` before return.
   */
  async getFullText(itemKey: string): Promise<ZoteroFullTextResultDTO> {
    if (!itemKey) return emptyResult();

    // Tier 2 priority: MinerU precise-parse output (structured markdown,
    // formula/table fidelity). No mtime invalidation — parsing burns quota,
    // overwrite only on explicit user re-parse.
    const mineru = await this.readMinerUCache(itemKey);
    if (mineru !== null) {
      const truncated = truncateToBytes(mineru, MAX_TEXT_BYTES);
      // Structured MD is treated as high quality (formula/table fidelity), no self-check.
      return { text: truncated, truncated: truncated !== mineru, tier: 'mineru', quality: 'good' };
    }

    const pdfPath = await this.resolvePdfPath(itemKey);
    if (!pdfPath) {
      logger.info('no PDF attachment', { itemKey });
      return emptyResult();
    }

    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fs.stat(pdfPath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      logger.warn('PDF file not readable', { itemKey, pdfPath, error: errMsg(err) });
      return emptyResult();
    }

    const cached = await this.readCache(itemKey, pdfPath, stat);
    const text = cached ?? (await this.extractAndCache(itemKey, pdfPath, stat));
    if (text === null) return emptyResult();

    const truncatedText = truncateToBytes(text, MAX_TEXT_BYTES);
    return {
      text: truncatedText,
      truncated: truncatedText !== text,
      tier: 'local',
      // Compute readability only on full (non-truncated) extraction; truncation
      // is just tail elision and does not affect quality judgment.
      quality: computeReadability(text),
    };
  }

  // ============================================================
  // PDF location
  // ============================================================

  private async resolvePdfPath(itemKey: string): Promise<string | null> {
    return resolveZoteroPdfPath(itemKey, this.api);
  }

  // ============================================================
  // Cache
  // ============================================================

  private cacheDir(itemKey: string): string {
    return zoteroItemCacheDir(itemKey);
  }

  private async readCache(
    itemKey: string,
    pdfPath: string,
    stat: { mtimeMs: number; size: number }
  ): Promise<string | null> {
    const dir = this.cacheDir(itemKey);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf-8')) as CacheMeta;
      const fresh =
        meta.pdfPath === pdfPath &&
        Math.floor(meta.pdfMtimeMs) === Math.floor(stat.mtimeMs) &&
        meta.pdfSize === stat.size;
      if (!fresh) return null;
      return await fs.readFile(path.join(dir, 'content.txt'), 'utf-8');
    } catch {
      return null; // No cache / corrupted -> treat as miss.
    }
  }

  /** Read MinerU tier (`parsed/full.md`). Return if present, no mtime check. */
  private async readMinerUCache(itemKey: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(zoteroParsedDir(itemKey), 'full.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * For the "Papers" panel's "Parsed MD" view: returns the full markdown
   * (no truncation) plus the absolute parsed dir path (renderer uses it to
   * rewrite relative image refs into scipen-file:// URLs). No parse -> null.
   */
  async getParsedMarkdown(
    itemKey: string
  ): Promise<{ markdown: string; parsedDir: string } | null> {
    const markdown = await this.readMinerUCache(itemKey);
    if (markdown === null) return null;
    return { markdown, parsedDir: zoteroParsedDir(itemKey) };
  }

  /**
   * Read MinerU's `*_content_list.json` (paragraph bbox + page_idx), used by
   * cite hover to pick the screenshot region. Filename is UUID-prefixed (not
   * fixed) -> readdir matches the suffix. No parse / corrupted -> null.
   */
  async getContentList(itemKey: string): Promise<MinerUContentList | null> {
    const dir = zoteroParsedDir(itemKey);
    try {
      const files = await fs.readdir(dir);
      const name = files.find((f) => f.endsWith('_content_list.json'));
      if (!name) return null;
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
      return Array.isArray(parsed) ? (parsed as MinerUContentList) : null;
    } catch {
      return null;
    }
  }

  private async extractAndCache(
    itemKey: string,
    pdfPath: string,
    stat: { mtimeMs: number; size: number }
  ): Promise<string | null> {
    let text: string;
    try {
      const buffer = await fs.readFile(pdfPath);
      const parsed = await pdfParse(buffer);
      text = parsed.text ?? '';
    } catch (err) {
      logger.warn('pdf-parse failed', { itemKey, pdfPath, error: errMsg(err) });
      return null;
    }

    const dir = this.cacheDir(itemKey);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'content.txt'), text, 'utf-8');
      const meta: CacheMeta = {
        pdfPath,
        pdfMtimeMs: stat.mtimeMs,
        pdfSize: stat.size,
        extractedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
      logger.info('full text cached', { itemKey, chars: text.length });
    } catch (err) {
      // Cache write failure is not fatal — text is already extracted, return
      // it this round and re-extract next time.
      logger.warn('cache write failed', { itemKey, error: errMsg(err) });
    }
    return text;
  }
}

/**
 * Resolve a Zotero item's PDF attachment local path. Shared by full-text
 * extraction and embedded PDF rendering.
 *   - linked_file -> user-managed absolute path
 *   - imported_file / imported_url -> {dataDir}/storage/{attachmentKey}/{filename}
 * No PDF attachment / cannot resolve -> null.
 */
export async function resolveZoteroPdfPath(
  itemKey: string,
  api: ZoteroLocalApiClient = getZoteroLocalApiClient()
): Promise<string | null> {
  let attachments;
  try {
    attachments = await api.getItemAttachments(itemKey);
  } catch (err) {
    logger.warn('getItemAttachments failed', { itemKey, error: errMsg(err) });
    return null;
  }
  const pdf = attachments.find((a) => a.contentType === 'application/pdf');
  if (!pdf) return null;

  if (pdf.linkMode === 'linked_file' && pdf.path) {
    return pdf.path;
  }
  if (pdf.filename) {
    const dataDir = await resolveZoteroDataDir();
    if (dataDir) {
      return path.join(dataDir, 'storage', pdf.itemKey, pdf.filename);
    }
  }
  return null;
}

function emptyResult(): ZoteroFullTextResultDTO {
  return { text: '', truncated: false, tier: 'none' };
}

/**
 * Tier-1 extraction readability self-check. Conservatively judges `poor`
 * (better to under-report than spam users with false positives). Only two
 * unambiguous signals: (1) decode failure marker (U+FFFD) + elevated control
 * char ratio -> true garbage from fonts missing ToUnicode; (2) readable
 * chars (letters incl. CJK + digits) ratio is very low -> scanned/image-only
 * PDF with no extractable text. Chinese papers' hanzi are `\p{L}`, naturally
 * high ratio, no false positives.
 */
function computeReadability(text: string): 'good' | 'poor' {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'poor';
  let readable = 0; // letters (incl. CJK) + digits
  let garbled = 0; // U+FFFD + C0 controls (excluding \t\n\r)
  let total = 0; // non-whitespace chars
  for (const ch of trimmed) {
    if (/\s/u.test(ch)) continue;
    total++;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '�' || (cp < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r')) {
      garbled++;
    } else if (/\p{L}|\p{N}/u.test(ch)) {
      readable++;
    }
  }
  if (total === 0) return 'poor';
  if (garbled / total > 0.05) return 'poor';
  if (readable / total < 0.3) return 'poor';
  return 'good';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let singleton: ZoteroFullTextService | null = null;

export function getZoteroFullTextService(): ZoteroFullTextService {
  if (!singleton) {
    singleton = new ZoteroFullTextService();
  }
  return singleton;
}
