/**
 * @file ZoteroFullTextService —— 按需把 Zotero 论文 PDF 抽成正文纯文本,
 *   供 LLM 的 `zotero_read` 反向 RPC 拉取(文本来源档 1:本地 pdf-parse)。
 *
 * 数据流:itemKey → LocalApi 查 PDF 附件 → 解析本地文件路径 → pdf-parse
 * 抽文本 → 写全局缓存 `~/.scipen-studio/zotero-cache/<itemKey>/`。缓存按
 * itemKey 去重(论文属文献库,跨项目共享),mtime+size 做廉价失效守卫。
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import type { ZoteroFullTextResultDTO } from '../../../../shared/types/zotero';
import { truncateToBytes } from '../../../../shared/utils';
import { createLogger } from '../LoggerService';
import { getZoteroLocalApiClient, ZoteroLocalApiClient } from './ZoteroLocalApiClient';
import { resolveZoteroDataDir } from './ZoteroDiscoveryService';

const logger = createLogger('ZoteroFullTextService');

/** 单篇返回上限,与 AtMentionResolver 的 @file 上限对齐(超出截断 + 标记)。 */
const MAX_TEXT_BYTES = 200 * 1024;

const CACHE_ROOT = path.join(os.homedir(), '.scipen-studio', 'zotero-cache');

interface CacheMeta {
  /** 源 PDF 绝对路径。 */
  pdfPath: string;
  /** 廉价失效守卫:PDF 文件 mtime + size 任一变即重抽。 */
  pdfMtimeMs: number;
  pdfSize: number;
  extractedAt: string;
}

export class ZoteroFullTextService {
  constructor(private readonly api: ZoteroLocalApiClient = getZoteroLocalApiClient()) {}

  /**
   * 取一篇论文的正文纯文本。无 PDF 附件 → `tier:'none'`;成功 → `tier:'local'`。
   * 命中缓存(PDF 未变)跳过 pdf-parse;返回前按 `MAX_TEXT_BYTES` 截断。
   */
  async getFullText(itemKey: string): Promise<ZoteroFullTextResultDTO> {
    if (!itemKey) return emptyResult();

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
    };
  }

  // ============================================================
  // PDF 定位
  // ============================================================

  private async resolvePdfPath(itemKey: string): Promise<string | null> {
    let attachments;
    try {
      attachments = await this.api.getItemAttachments(itemKey);
    } catch (err) {
      logger.warn('getItemAttachments failed', { itemKey, error: errMsg(err) });
      return null;
    }
    const pdf = attachments.find((a) => a.contentType === 'application/pdf');
    if (!pdf) return null;

    // linked_file:用户自管的绝对路径。
    if (pdf.linkMode === 'linked_file' && pdf.path) {
      return pdf.path;
    }
    // imported_file / imported_url:存在 {dataDir}/storage/{attachmentKey}/{filename}。
    if (pdf.filename) {
      const dataDir = await resolveZoteroDataDir();
      if (dataDir) {
        return path.join(dataDir, 'storage', pdf.itemKey, pdf.filename);
      }
    }
    return null;
  }

  // ============================================================
  // 缓存
  // ============================================================

  private cacheDir(itemKey: string): string {
    // itemKey 是 8 位 [A-Z0-9],无路径分隔符;直接作目录名安全。
    return path.join(CACHE_ROOT, itemKey);
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
      return null; // 无缓存 / 损坏 → 视为 miss。
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
      // 写缓存失败不致命 —— 文本已抽出,本次照常返回,下次再抽。
      logger.warn('cache write failed', { itemKey, error: errMsg(err) });
    }
    return text;
  }
}

function emptyResult(): ZoteroFullTextResultDTO {
  return { text: '', truncated: false, tier: 'none' };
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

/** Tests only. */
export function __resetZoteroFullTextSingleton(): void {
  singleton = null;
}
