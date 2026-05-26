/**
 * @file BibTexSyncService —— 把 Zotero canonical 索引同步成项目 root 下的
 *   `references.bib`,让 LaTeX/Biber/BibTeX 编译能找到 \cite{} 引用。
 *
 * @description 数据流(全自动闭环):
 *
 *   Zotero 改 → Orchestrator refresh → ZoteroIndex.applyPatch
 *            → EventBus.emit('bib:patch' / 'bib:initial')
 *            → BibTexSyncService 收到事件 → debounce 500 ms
 *            → BBT exportBibTex(allCitationKeys, translator)
 *            → 算 hash,与上次写入比较;若变化:
 *                a. 检测用户是否手改过(我们记的 mtime 与当前 mtime 不一致)
 *                   → 是 → 标记 conflict,不覆盖,UI 提示
 *                   → 否 → 写新内容,记 mtime + hash
 *            → 编辑器编译时 bibtex/biber 读 references.bib 即可
 *
 *   设计取舍:
 *   - **全量重写**:5k entry 实测 < 100 ms 写盘,简单;增量追加易出错。
 *   - **BetterBibLaTeX 默认 translator**:UTF-8 友好 / 现代字段全;可配置。
 *   - **mtime + hash 双守卫**:仅 mtime 易误判(同秒写两次),仅 hash 看不出
 *     外部覆写;两者并存才稳。
 *   - **空 ck fallback**:库里没装 BBT(degraded)→ exportBibTex 空 → 不写盘。
 *     这种场景下 .bib 留空是对的 —— citation key 都没有,写也没用。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { BibTexSyncStatusDTO } from '../../../../shared/types/zotero-events';
import type { BibTexSyncConfigDTO } from '../../../../shared/types/zotero';
import type { BetterBibTexClient } from './BetterBibTexClient';
import { getBetterBibTexClient } from './BetterBibTexClient';
import type { ZoteroEventBus } from './ZoteroEventBus';
import { getZoteroEventBus } from './ZoteroEventBus';
import type { ZoteroIndex } from './ZoteroIndex';
import { getZoteroOrchestrator } from './ZoteroOrchestrator';
import { createLogger } from '../LoggerService';

const logger = createLogger('BibTexSyncService');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_FILE_NAME = 'references.bib';
const DEFAULT_TRANSLATOR = 'BetterBibLaTeX';

export type BibTexSyncConfig = BibTexSyncConfigDTO;
export type BibTexSyncStatus = BibTexSyncStatusDTO;

export const DEFAULT_BIBTEX_SYNC_CONFIG: BibTexSyncConfigDTO = {
  enabled: true,
  fileName: DEFAULT_FILE_NAME,
  translator: DEFAULT_TRANSLATOR,
};

export interface BibTexSyncDeps {
  index: ZoteroIndex;
  bbt?: BetterBibTexClient;
  bus?: ZoteroEventBus;
  /** 注入 fs 模块,便于测试。默认走 node:fs/promises。 */
  fileIO?: typeof fs;
  /** debounce 时长,测试可缩短。 */
  debounceMs?: number;
}

export class BibTexSyncService {
  private readonly index: ZoteroIndex;
  private readonly bbt: BetterBibTexClient;
  private readonly bus: ZoteroEventBus;
  private readonly fileIO: typeof fs;
  private readonly debounceMs: number;

  private projectPath: string | null = null;
  private config: BibTexSyncConfig = DEFAULT_BIBTEX_SYNC_CONFIG;
  private status: BibTexSyncStatus = { kind: 'idle' };

  /** 上次成功写入的 hash + mtime;守卫用。 */
  private lastWrittenHash: string | null = null;
  private lastWrittenMtimeMs: number | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<BibTexSyncStatus> | null = null;
  private unsubBus: (() => void) | null = null;

  constructor(deps: BibTexSyncDeps) {
    this.index = deps.index;
    this.bbt = deps.bbt ?? getBetterBibTexClient();
    this.bus = deps.bus ?? getZoteroEventBus();
    this.fileIO = deps.fileIO ?? fs;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /** 启动 —— 订阅 bib 事件。可重入(再次 start 是 no-op)。 */
  start(): void {
    if (this.unsubBus) return;
    this.unsubBus = this.bus.on((event) => {
      if (event.kind === 'bib:initial' || event.kind === 'bib:patch') {
        this.scheduleSync();
      }
    });
    logger.info('BibTexSyncService started');
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
    this.status = { kind: 'idle' };
  }

  /** 项目切换时更新目标路径。null 关闭自动同步。 */
  setProjectPath(projectPath: string | null): void {
    if (this.projectPath === projectPath) return;
    this.projectPath = projectPath;
    // 项目变了,我们之前记的 mtime/hash 对应的是旧项目下的 .bib,要重置;
    // 否则切回旧项目时会误判"用户改过"。
    this.lastWrittenHash = null;
    this.lastWrittenMtimeMs = null;
    if (projectPath) this.scheduleSync();
  }

  /** 设置变更时调用。enabled 翻 true 自动触发一次同步。 */
  setConfig(next: Partial<BibTexSyncConfig>): void {
    const prev = this.config;
    this.config = { ...this.config, ...next };
    if (!prev.enabled && this.config.enabled) {
      this.scheduleSync();
    }
    // fileName 改变意味着旧 mtime/hash 对应错文件,重置守卫。
    if (next.fileName && next.fileName !== prev.fileName) {
      this.lastWrittenHash = null;
      this.lastWrittenMtimeMs = null;
      this.scheduleSync();
    }
  }

  getStatus(): BibTexSyncStatus {
    return this.status;
  }

  /** 用户手动触发(忽略 enabled 网关、跳过 debounce)。 */
  async syncNow(): Promise<BibTexSyncStatus> {
    return this.runSync({ force: true });
  }

  // ============================================================
  // Internals
  // ============================================================

  private scheduleSync(): void {
    if (!this.config.enabled || !this.projectPath) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSync({ force: false });
    }, this.debounceMs);
  }

  private async runSync(opts: { force: boolean }): Promise<BibTexSyncStatus> {
    if (this.inFlight) return this.inFlight;
    const promise = this.doSync(opts).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  private async doSync(opts: { force: boolean }): Promise<BibTexSyncStatus> {
    if (!opts.force && !this.config.enabled) {
      this.status = { kind: 'idle' };
      return this.status;
    }
    if (!this.projectPath) {
      this.status = { kind: 'error', reason: 'No active project' };
      return this.status;
    }

    this.status = { kind: 'syncing' };

    const citationKeys = this.collectCitationKeys();
    if (citationKeys.length === 0) {
      // 没有任何 BBT key,写一份空文件没意义。把 .bib 留原状态。
      this.status = { kind: 'idle' };
      return this.status;
    }

    let bib: string;
    try {
      bib = await this.bbt.exportBibTex(citationKeys, this.config.translator);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.status = { kind: 'error', reason: `BBT export failed: ${reason}` };
      return this.status;
    }

    const filePath = path.join(this.projectPath, this.config.fileName);
    const nextHash = sha256(bib);

    // 内容没变:连写盘都跳过。
    if (this.lastWrittenHash === nextHash) {
      const lastSyncedAt = new Date().toISOString();
      this.status = { kind: 'skipped-no-change', filePath, lastSyncedAt };
      return this.status;
    }

    // mtime 守卫:文件存在且 mtime 不等于我们上次写的 mtime → 外部改过。
    try {
      const stat = await this.fileIO.stat(filePath);
      if (
        this.lastWrittenMtimeMs !== null &&
        Math.floor(stat.mtimeMs) !== Math.floor(this.lastWrittenMtimeMs)
      ) {
        // 但若当前文件 hash 与 nextHash 已相等,说明并发但内容刚好一致,放心覆盖。
        const currentContent = await this.fileIO.readFile(filePath, 'utf-8');
        if (sha256(currentContent) !== nextHash) {
          this.status = {
            kind: 'conflict',
            filePath,
            reason: '检测到外部修改了 references.bib;为防数据丢失暂不覆盖',
          };
          return this.status;
        }
      }
    } catch (err) {
      // 文件不存在是正常路径(首次同步),继续写。
      if (!isFileNotFound(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        this.status = { kind: 'error', reason: `stat failed: ${reason}` };
        return this.status;
      }
    }

    try {
      await this.fileIO.writeFile(filePath, bib, 'utf-8');
      const stat = await this.fileIO.stat(filePath);
      this.lastWrittenHash = nextHash;
      this.lastWrittenMtimeMs = stat.mtimeMs;
      this.status = {
        kind: 'ok',
        filePath,
        bytesWritten: Buffer.byteLength(bib, 'utf-8'),
        lastSyncedAt: new Date().toISOString(),
      };
      logger.info('BibTeX synced', {
        filePath,
        bytes: this.status.bytesWritten,
        keys: citationKeys.length,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.status = { kind: 'error', reason: `writeFile failed: ${reason}` };
    }
    return this.status;
  }

  private collectCitationKeys(): string[] {
    const out: string[] = [];
    for (const item of this.index.values()) {
      if (item.citationKey) out.push(item.citationKey);
    }
    return out;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}

let singleton: BibTexSyncService | null = null;

export function getBibTexSyncService(): BibTexSyncService {
  if (!singleton) {
    singleton = new BibTexSyncService({
      index: getZoteroOrchestrator().getIndex(),
    });
  }
  return singleton;
}

/** Tests only. */
export function __resetBibTexSyncSingleton(): void {
  singleton?.stop();
  singleton = null;
}
