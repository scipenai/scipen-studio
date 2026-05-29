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

/** 全局论文缓存根(跨项目按 itemKey 去重)。MinerU 解析产物 / 全文抽取共用。 */
export const ZOTERO_CACHE_ROOT = path.join(os.homedir(), '.scipen-studio', 'zotero-cache');

/** 某条目的缓存目录 `<root>/<itemKey>/`。itemKey 是 8 位 [A-Z0-9],作目录名安全。 */
export function zoteroItemCacheDir(itemKey: string): string {
  return path.join(ZOTERO_CACHE_ROOT, itemKey);
}

/** MinerU 解析产物目录 `<itemKey>/parsed/`(full.md + content_list.json + images)。 */
export function zoteroParsedDir(itemKey: string): string {
  return path.join(zoteroItemCacheDir(itemKey), 'parsed');
}

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

    // 档2 优先:MinerU 精解析产物(结构化 markdown,公式/表格保真)。无 mtime
    // 失效 —— 解析烧配额,仅用户显式重解析时覆盖。
    const mineru = await this.readMinerUCache(itemKey);
    if (mineru !== null) {
      const truncated = truncateToBytes(mineru, MAX_TEXT_BYTES);
      // 结构化 MD 视为高质量(公式/表格已保真),不再自检。
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
      // 对完整抽取(非截断)算可读性,截断只是尾部省略不影响质量判断。
      quality: computeReadability(text),
    };
  }

  // ============================================================
  // PDF 定位
  // ============================================================

  private async resolvePdfPath(itemKey: string): Promise<string | null> {
    return resolveZoteroPdfPath(itemKey, this.api);
  }

  // ============================================================
  // 缓存
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
      return null; // 无缓存 / 损坏 → 视为 miss。
    }
  }

  /** 读 MinerU 档(`parsed/full.md`)。存在即返回,无 mtime 校验。 */
  private async readMinerUCache(itemKey: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(zoteroParsedDir(itemKey), 'full.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * 给「论文」面板的「解析 MD」视图用:返回完整 markdown(不截断)+ parsed 目录
   * 绝对路径(renderer 据此把相对图片引用重写成 scipen-file:// URL)。无解析 → null。
   */
  async getParsedMarkdown(itemKey: string): Promise<{ markdown: string; parsedDir: string } | null> {
    const markdown = await this.readMinerUCache(itemKey);
    if (markdown === null) return null;
    return { markdown, parsedDir: zoteroParsedDir(itemKey) };
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

/**
 * 解析一个 Zotero 条目的 PDF 附件本地路径。全文抽取与 PDF 内嵌渲染共用。
 *   - linked_file → 用户自管的绝对路径
 *   - imported_file / imported_url → {dataDir}/storage/{attachmentKey}/{filename}
 * 无 PDF 附件 / 无法定位 → null。
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
 * 档1 抽取可读性自检。保守判 `poor`(宁可漏报不可误报骚扰用户),只认两个
 * 明确信号:① 解码失败标志(�)+ 控制符占比偏高 → 字体无 ToUnicode 的
 * 真乱码;② 可读字符(字母含 CJK / 数字)占比极低 → 扫描版/纯图抽不出文字。
 * 中文论文的汉字属 `\p{L}`,占比天然高,不会误判。
 */
function computeReadability(text: string): 'good' | 'poor' {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'poor';
  let readable = 0; // 字母(含 CJK)+ 数字
  let garbled = 0; // � + C0/C1 控制符(排除 \t\n\r)
  let total = 0; // 非空白字符
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
