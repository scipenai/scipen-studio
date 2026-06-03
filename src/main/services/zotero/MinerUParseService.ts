/**
 * @file MinerUParseService —— 用 MinerU 云 API 把 Zotero 论文 PDF 精解析为
 *   结构化 markdown(档2)。本地文件流程:申请上传 URL → PUT bytes → 轮询
 *   batch 结果 → 下载 zip → 解压到 `<itemKey>/parsed/`。进度经事件广播。
 *
 * 隐私:PDF 上传到第三方 MinerU 云;token 明文只在 main(keychain 读出)。
 * 缓存按 itemKey 全局去重;解析烧配额,故同 itemKey 不重复提交,且产物无
 * mtime 失效(仅用户显式重解析覆盖)。
 */

import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import extract from 'extract-zip';
import { IpcChannel } from '../../../../shared/ipc/channels';
import type {
  MinerUModelVersion,
  MinerUParseState,
  MinerUParseStatusDTO,
} from '../../../../shared/types/zotero-mineru';
import { timeout } from '../../../../shared/utils';
import { getZoteroMinerUApiKey } from '../SecureStorageService';
import { createLogger } from '../LoggerService';
import { resolveZoteroPdfPath, zoteroParsedDir } from './ZoteroFullTextService';

const logger = createLogger('MinerUParseService');

const BASE_URL = 'https://mineru.net/api/v4';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟硬上限
const HTTP_TIMEOUT_MS = 30_000; // 单次 HTTP(上传/下载更大文件)
const MAX_PDF_BYTES = 200 * 1024 * 1024; // MinerU 200MB 上限,本地预检

interface MinerUEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

export class MinerUParseService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly statuses = new Map<string, MinerUParseStatusDTO>();
  private lastBroadcastAt = 0;

  getStatus(itemKey: string): MinerUParseStatusDTO {
    return (
      this.statuses.get(itemKey) ?? { itemKey, state: 'idle', updatedAt: new Date().toISOString() }
    );
  }

  /** 触发解析。同 itemKey 已在进行则复用,不重复提交(省配额)。 */
  parse(itemKey: string, model: MinerUModelVersion = 'pipeline'): Promise<void> {
    const existing = this.inFlight.get(itemKey);
    if (existing) return existing;
    const p = this.run(itemKey, model).finally(() => this.inFlight.delete(itemKey));
    this.inFlight.set(itemKey, p);
    return p;
  }

  // ============================================================
  // 核心状态机
  // ============================================================

  private async run(itemKey: string, model: MinerUModelVersion): Promise<void> {
    try {
      const token = getZoteroMinerUApiKey();
      if (!token) throw new MinerUError('MINERU_NO_TOKEN', 'MinerU API token not configured');

      const pdfPath = await resolveZoteroPdfPath(itemKey);
      if (!pdfPath) throw new MinerUError('NO_PDF_ATTACHMENT', 'no PDF attachment');

      const bytes = await fs.readFile(pdfPath);
      if (bytes.byteLength > MAX_PDF_BYTES) {
        throw new MinerUError('-60005', 'PDF exceeds 200MB');
      }

      this.emit(itemKey, 'uploading');
      const { batchId, uploadUrl } = await this.applyUpload(token, itemKey, model);
      await this.put(uploadUrl, bytes);

      const zipUrl = await this.poll(token, batchId, itemKey);

      this.emit(itemKey, 'downloading');
      const zipBytes = await this.download(zipUrl);

      this.emit(itemKey, 'extracting');
      await this.unzipToCache(itemKey, zipBytes);

      this.emit(itemKey, 'done');
      logger.info('MinerU parse done', { itemKey });
    } catch (err) {
      const { code, message } = toErr(err);
      this.statuses.set(itemKey, {
        itemKey,
        state: 'failed',
        errorCode: code,
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      });
      this.broadcast(this.statuses.get(itemKey)!, true);
      logger.warn('MinerU parse failed', { itemKey, code, message });
    }
  }

  // ============================================================
  // MinerU API 调用
  // ============================================================

  private async applyUpload(
    token: string,
    itemKey: string,
    model: MinerUModelVersion
  ): Promise<{ batchId: string; uploadUrl: string }> {
    const res = await this.fetchJson<{ batch_id: string; file_urls: string[] }>(
      `${BASE_URL}/file-urls/batch`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          files: [{ name: `${itemKey}.pdf`, data_id: itemKey }],
          model_version: model,
        }),
      }
    );
    const uploadUrl = res.file_urls?.[0];
    if (!res.batch_id || !uploadUrl) {
      throw new MinerUError('generic', 'no batch_id / upload url in response');
    }
    return { batchId: res.batch_id, uploadUrl };
  }

  /** PUT 上传到预签名 OSS URL。不设 Content-Type(MinerU 要求)。 */
  private async put(url: string, bytes: Buffer): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS * 2);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
        signal: controller.signal,
      });
      if (!res.ok) throw new MinerUError('generic', `upload PUT HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 轮询 batch 结果直到 done;超时/failed 抛错。返回 full_zip_url。 */
  private async poll(token: string, batchId: string, itemKey: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await this.fetchJson<{
        extract_result: Array<{
          state: string;
          full_zip_url?: string;
          err_msg?: string;
          extract_progress?: { extracted_pages?: number; total_pages?: number };
        }>;
      }>(`${BASE_URL}/extract-results/batch/${encodeURIComponent(batchId)}`, token, {
        method: 'GET',
      });

      const r = res.extract_result?.[0];
      if (r) {
        if (r.state === 'done' && r.full_zip_url) return r.full_zip_url;
        if (r.state === 'failed') {
          throw new MinerUError(parseErrCode(r.err_msg), r.err_msg ?? 'MinerU parse failed');
        }
        if (r.state === 'running') {
          this.emit(itemKey, 'running', {
            extractedPages: r.extract_progress?.extracted_pages,
            totalPages: r.extract_progress?.total_pages,
          });
        } else {
          // waiting-file / pending / converting
          this.emit(itemKey, normalizeRemoteState(r.state));
        }
      }

      if (Date.now() > deadline) {
        throw new MinerUError('MINERU_TIMEOUT', `polling timed out after ${POLL_TIMEOUT_MS}ms`);
      }
      await timeout(POLL_INTERVAL_MS);
    }
  }

  private async download(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS * 2);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new MinerUError('generic', `download HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  private async unzipToCache(itemKey: string, zipBytes: Buffer): Promise<void> {
    const parsedDir = zoteroParsedDir(itemKey);
    const tmpZip = path.join(os.tmpdir(), `mineru-${itemKey}-${process.pid}.zip`);
    try {
      await fs.mkdir(parsedDir, { recursive: true });
      await fs.writeFile(tmpZip, zipBytes);
      await extract(tmpZip, { dir: parsedDir });
      await fs.access(path.join(parsedDir, 'full.md')); // 校验产物存在
    } finally {
      await fs.rm(tmpZip, { force: true }).catch(() => undefined);
    }
  }

  /** MinerU JSON-RPC 封套调用,校验 code===0,失败按 code/msg 抛 MinerUError。 */
  private async fetchJson<T>(url: string, token: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let raw: MinerUEnvelope<T>;
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new MinerUError('generic', `MinerU HTTP ${res.status}`);
      raw = (await res.json()) as MinerUEnvelope<T>;
    } finally {
      clearTimeout(timer);
    }
    if (raw.code !== 0 || raw.data === undefined) {
      throw new MinerUError(String(raw.code), raw.msg ?? 'MinerU API error');
    }
    return raw.data;
  }

  // ============================================================
  // 状态广播
  // ============================================================

  private emit(
    itemKey: string,
    state: MinerUParseState,
    extra?: { extractedPages?: number; totalPages?: number }
  ): void {
    const status: MinerUParseStatusDTO = {
      itemKey,
      state,
      extractedPages: extra?.extractedPages,
      totalPages: extra?.totalPages,
      updatedAt: new Date().toISOString(),
    };
    this.statuses.set(itemKey, status);
    // running 进度高频,节流 200ms;其余状态(阶段切换)立即广播。
    this.broadcast(status, state !== 'running');
  }

  private broadcast(status: MinerUParseStatusDTO, force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcastAt < 200) return;
    this.lastBroadcastAt = now;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.Zotero_MinerUProgress, status);
      }
    }
  }
}

class MinerUError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MinerUError';
  }
}

function toErr(err: unknown): { code: string; message: string } {
  if (err instanceof MinerUError) return { code: err.code, message: err.message };
  return { code: 'generic', message: err instanceof Error ? err.message : String(err) };
}

/** 从 MinerU err_msg 文本里捞错误码(优先精确码,否则 generic)。 */
function parseErrCode(msg?: string): string {
  if (!msg) return 'generic';
  const m = msg.match(/(A0\d{3}|-\d{4,5})/);
  return m ? m[1] : 'generic';
}

function normalizeRemoteState(state: string): MinerUParseState {
  switch (state) {
    case 'pending':
    case 'waiting-file':
      return 'pending';
    case 'converting':
      return 'converting';
    default:
      return 'pending';
  }
}

let singleton: MinerUParseService | null = null;

export function getMinerUParseService(): MinerUParseService {
  if (!singleton) {
    singleton = new MinerUParseService();
  }
  return singleton;
}
