/**
 * @file ZoteroBibMirror —— renderer 侧 canonical bib 索引镜像
 * @description 单实例镜像 main 进程的 ZoteroIndex 全量数据 + 增量补丁。
 *              订阅 `Zotero_Event` 通道,内部维护 `items` / `keyToItem` +
 *              cite 专用倒排索引(citation-key 前缀 + token + haystack),
 *              通过 `subscribe` 暴露给 React (兼容 useSyncExternalStore)。
 *              诊断信息(数据源健康度)走 IPC 拉取,不缓存在镜像里。
 *
 *              Lifecycle:
 *                未启用(idle)→ start() → 订阅事件 + 拉取 getSnapshot 全量
 *                                 → 接 bib:initial/patch/status 增量
 *                                 → dispose() 清理(取订阅 + 清数据)
 *
 *              IPC 时序 — 先订阅再拉快照,任何中途到达的 patch 都不会丢失;
 *              快照与 patch 各自带 etag,本地按"已 apply 过则跳过"的原则做去重。
 *
 *              搜索评分见 bibSearchScoring.ts(citation-key 前缀 → token 交集
 *              → substring fallback 三档),从 m2-stash 的 Worker 端口移植。
 */

import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';
import type {
  BibSnapshotDTO,
  BibStatus,
  GetSnapshotResultDTO,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
  ZoteroEventDTO,
} from '../../../../../shared/types/zotero-events';
import { api } from '../../api';
import { createLogger } from '../LogService';
import {
  buildHaystack,
  searchBibCorpus,
  tokenize,
  type BibSearchHit,
} from './bibSearchScoring';

const logger = createLogger('ZoteroBibMirror');

/** 视图层订阅时拿到的最小状态切片(配合 useSyncExternalStore)。 */
export interface ZoteroBibMirrorState {
  status: BibStatus;
  etag: string;
  itemCount: number;
  /** ISO 8601 字符串;首次 hydrate 之前为 undefined。 */
  lastSyncedAt?: string;
  /** Mirror 是否已成功完成首次 hydrate。 */
  ready: boolean;
}

type Listener = () => void;

const INITIAL_STATE: ZoteroBibMirrorState = {
  status: 'idle',
  etag: '',
  itemCount: 0,
  ready: false,
};

export class ZoteroBibMirror {
  private items = new Map<string, ZoteroItemDTO>();
  /** 大小写敏感的 citationKey → itemKey,getByCitationKey 走这里。 */
  private keyToItem = new Map<string, string>();
  /** 小写 citationKey → itemKey,搜索时前缀匹配用。 */
  private citationKeyLower = new Map<string, string>();
  /** token(lowercase ≥2 char)→ itemKey 集合,搜索 token 评分用。 */
  private tokenIndex = new Map<string, Set<string>>();
  /** itemKey → 小写拼接 haystack,substring fallback 用。 */
  private haystacks = new Map<string, string>();

  private state: ZoteroBibMirrorState = INITIAL_STATE;
  private stateSnapshot: ZoteroBibMirrorState = INITIAL_STATE;

  private readonly listeners = new Set<Listener>();
  private unsubEvent: (() => void) | null = null;
  private starting = false;
  private disposed = false;

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * 启动镜像 —— 订阅事件、拉取初始快照。重入安全(并发调用合并为一次)。
   * 已 stop 后允许再次 start();dispose 是终止操作,start 会被忽略。
   */
  async start(): Promise<void> {
    if (this.disposed || this.starting || this.state.ready) return;
    this.starting = true;
    try {
      // 必须先订阅,再拉快照;反之中间到达的 patch 会丢。
      this.unsubEvent = api.zotero.onEvent((event) => this.handleEvent(event));

      const snapshot = await api.zotero.getSnapshot({});
      this.applySnapshotResult(snapshot);
    } catch (err) {
      logger.warn('start: initial getSnapshot failed', err);
    } finally {
      this.starting = false;
    }
  }

  /**
   * 停止镜像 —— 取订阅 + 清数据 + 状态回到 idle。
   * **保留** subscribe 监听者,UI 仍可观察到状态回到 idle,后续 start() 可恢复。
   */
  stop(): void {
    this.unsubEvent?.();
    this.unsubEvent = null;
    this.items.clear();
    this.keyToItem.clear();
    this.citationKeyLower.clear();
    this.tokenIndex.clear();
    this.haystacks.clear();
    this.state = INITIAL_STATE;
    this.bumpSnapshot();
  }

  /** 终止操作 —— stop + 清空 subscribe 监听者。仅在测试/进程退出场景使用。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  // ============================================================
  // Subscription (useSyncExternalStore-friendly)
  // ============================================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 返回稳定引用:仅在状态变化后才换新对象,可直接作为 useSyncExternalStore 的 snapshot。 */
  getState(): ZoteroBibMirrorState {
    return this.stateSnapshot;
  }

  // ============================================================
  // Sync reads
  // ============================================================

  getByCitationKey(citationKey: string): ZoteroItemDTO | undefined {
    if (!citationKey) return undefined;
    const itemKey = this.keyToItem.get(citationKey);
    return itemKey ? this.items.get(itemKey) : undefined;
  }

  getByItemKey(itemKey: string): ZoteroItemDTO | undefined {
    return this.items.get(itemKey);
  }

  /**
   * 返回 cite 候选并附评分(供 dropdown / completion provider 排序展示)。
   * 评分语义见 `bibSearchScoring.ts`(citation-key 前缀 → token 交集 → substring)。
   */
  searchByQueryWithScore(query: string, limit = 20): BibSearchHit[] {
    return searchBibCorpus(
      {
        items: this.items,
        citationKeyIndex: this.citationKeyLower,
        tokenIndex: this.tokenIndex,
        haystacks: this.haystacks,
      },
      query,
      limit
    );
  }

  /** 兼容旧调用方:直接拿排序好的 ZoteroItemDTO 列表,丢掉 score。 */
  searchByQuery(query: string, limit = 20): ZoteroItemDTO[] {
    return this.searchByQueryWithScore(query, limit).map((h) => h.item);
  }

  // ============================================================
  // Async surface (proxies main)
  // ============================================================

  /** 主动触发一次刷新(走 main 的 cooldown 防抖)。 */
  async refresh(): Promise<RefreshResultDTO> {
    return api.zotero.requestRefresh();
  }

  /** 拉取完整诊断(含数据源健康度)。Popover 打开时按需调用,不在 state 里缓存。 */
  async fetchDiagnostics(): Promise<ZoteroDiagnosticsDTO> {
    return api.zotero.getDiagnostics();
  }

  // ============================================================
  // Event handling
  // ============================================================

  private handleEvent(event: ZoteroEventDTO): void {
    if (this.disposed) return;
    switch (event.kind) {
      case 'bib:initial':
        this.applyInitial(event.snapshot);
        break;
      case 'bib:patch':
        if (event.etag === this.state.etag) return; // 已 apply(竞态保护)
        this.applyDelta(event.upserts, event.deletes, event.etag, event.status);
        break;
      case 'bib:status':
        if (this.state.status !== event.status) {
          this.state = { ...this.state, status: event.status };
          this.bumpSnapshot();
        }
        break;
      case 'bib:invalidated':
        // 纯信息事件 —— 后续会跟随 bib:status('syncing') 或 bib:patch,不需要立即动作。
        break;
    }
  }

  private applySnapshotResult(result: GetSnapshotResultDTO): void {
    if (result.reset) {
      this.replaceAll(result.items, result.etag, result.status);
    } else {
      this.applyDelta(result.upserts, result.deletes, result.etag, result.status);
    }
  }

  private applyInitial(snapshot: BibSnapshotDTO): void {
    this.replaceAll(snapshot.items, snapshot.etag, snapshot.status);
  }

  private replaceAll(items: ZoteroItemDTO[], etag: string, status: BibStatus): void {
    this.items.clear();
    this.keyToItem.clear();
    this.citationKeyLower.clear();
    this.tokenIndex.clear();
    this.haystacks.clear();
    for (const item of items) {
      this.indexItem(item);
    }
    this.state = {
      status,
      etag,
      itemCount: this.items.size,
      lastSyncedAt: new Date().toISOString(),
      ready: true,
    };
    this.bumpSnapshot();
  }

  private applyDelta(
    upserts: ZoteroItemDTO[],
    deletes: string[],
    etag: string,
    status: BibStatus
  ): void {
    for (const itemKey of deletes) {
      this.unindexItem(itemKey);
    }
    for (const item of upserts) {
      if (!item.itemKey) continue;
      // upsert 之前先 unindex 旧 item(citationKey/token/haystack 可能改了)。
      if (this.items.has(item.itemKey)) {
        this.unindexItem(item.itemKey);
      }
      this.indexItem(item);
    }
    this.state = {
      status,
      etag,
      itemCount: this.items.size,
      lastSyncedAt: new Date().toISOString(),
      ready: true,
    };
    this.bumpSnapshot();
  }

  private indexItem(item: ZoteroItemDTO): void {
    this.items.set(item.itemKey, item);
    if (item.citationKey) {
      this.keyToItem.set(item.citationKey, item.itemKey);
      this.citationKeyLower.set(item.citationKey.toLowerCase(), item.itemKey);
    }
    const haystack = buildHaystack(item);
    this.haystacks.set(item.itemKey, haystack);
    const seen = new Set<string>();
    for (const tok of tokenize(haystack)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      let set = this.tokenIndex.get(tok);
      if (!set) {
        set = new Set();
        this.tokenIndex.set(tok, set);
      }
      set.add(item.itemKey);
    }
  }

  private unindexItem(itemKey: string): void {
    const existing = this.items.get(itemKey);
    if (!existing) return;
    this.items.delete(itemKey);
    if (existing.citationKey) {
      const lower = existing.citationKey.toLowerCase();
      if (this.keyToItem.get(existing.citationKey) === itemKey) {
        this.keyToItem.delete(existing.citationKey);
      }
      if (this.citationKeyLower.get(lower) === itemKey) {
        this.citationKeyLower.delete(lower);
      }
    }
    const haystack = this.haystacks.get(itemKey);
    this.haystacks.delete(itemKey);
    if (haystack) {
      const seen = new Set<string>();
      for (const tok of tokenize(haystack)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        const set = this.tokenIndex.get(tok);
        if (set) {
          set.delete(itemKey);
          if (set.size === 0) this.tokenIndex.delete(tok);
        }
      }
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private bumpSnapshot(): void {
    this.stateSnapshot = this.state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn('subscriber threw', err);
      }
    }
  }
}

let singleton: ZoteroBibMirror | null = null;

export function getZoteroBibMirror(): ZoteroBibMirror {
  if (!singleton) {
    singleton = new ZoteroBibMirror();
  }
  return singleton;
}

/** Tests-only:重置单例。 */
export function __resetZoteroBibMirrorSingleton(): void {
  singleton?.dispose();
  singleton = null;
}
