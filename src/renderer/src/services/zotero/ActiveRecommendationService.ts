/**
 * @file ActiveRecommendationService —— M3 标尺5 渲染侧推荐编排单例。
 *
 * 职责:持有当前 Monaco editor 引用,监听编辑/光标变化 → debounce 1.5s →
 * 抽当前段落 → 段落 hash 守卫(没变不发)→ IPC 查询 main(embed+cosine+rerank)
 * → turnId 丢弃过期响应 → 通过 useSyncExternalStore 暴露给**叶子**面板。
 *
 * 卡顿红线([[project-studio-zotero-active-jank]]):监听独立于高频
 * setupContentChangeTracking;debounce + hash 守卫保证空闲/无变化时零 IPC;
 * 状态订阅只放叶子组件,绝不在 App 顶层。仅当 embedding 索引 state==='ready'
 * 时才发查询(disabled/no-key/building 时静默)。
 */

import type * as monaco from 'monaco-editor';
import { api } from '../../api';
import { createLogger } from '../LogService';
import { detectParagraphLang, extractFromEditor } from './recommendationTrigger';
import { formatCitationInsert } from '../../components/editor/citationKeyScan';
import type {
  EmbeddingIndexState,
  ZoteroEmbeddingResultItemDTO,
} from '../../../../../shared/types/zotero-embedding';

const logger = createLogger('ActiveRecommendation');

/** 编辑停顿多久后才查询(防打字途中刷 API)。 */
const DEBOUNCE_MS = 1500;

export interface RecommendationState {
  /** embedding 索引状态,驱动面板提示(配置 / 建库中 / 就绪)。 */
  indexState: EmbeddingIndexState;
  items: ZoteroEmbeddingResultItemDTO[];
  loading: boolean;
}

type Editor = monaco.editor.IStandaloneCodeEditor;
type Listener = () => void;

export class ActiveRecommendationService {
  private editor: Editor | null = null;
  private disposers: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private lastHash = '';
  private turnId = 0;
  private indexState: EmbeddingIndexState = 'disabled';
  private items: ZoteroEmbeddingResultItemDTO[] = [];
  private loading = false;
  /** 当前段落对全库可引用文献的相关度分(citationKey → score),供 @cite 下拉语义重排。 */
  private citationScores: Map<string, number> | null = null;

  private listeners = new Set<Listener>();
  private stateSnapshot: RecommendationState = {
    indexState: 'disabled',
    items: [],
    loading: false,
  };
  private unsubProgress: (() => void) | null = null;

  // ============================================================
  // 生命周期
  // ============================================================

  /** 编辑器挂载时调用(EditorPane handleEditorMount)。注册监听 + 拉初始状态。 */
  attachEditor(editor: Editor): void {
    this.editor = editor;
    this.disposers.push(
      editor.onDidChangeModelContent(() => this.scheduleQuery()).dispose,
      editor.onDidChangeCursorPosition(() => this.scheduleQuery()).dispose
    );

    if (!this.unsubProgress) {
      this.unsubProgress = api.zotero.onEmbeddingProgress((status) => {
        this.onIndexState(status.state);
      });
      void api.zotero.getEmbeddingStatus().then((s) => this.onIndexState(s.state));
    }
  }

  /**
   * 索引状态变化的统一入口。**翻转到 ready** 意味着索引内容刚重建/更新(手动
   * 重建 / provider / key 变更都经此),renderer 缓存的「上次查过的段落 hash」
   * 与「全库相关度分」已失效——必须清 lastHash 放行去重守卫,并主动补一次查询,
   * 否则光标停在同段不动时 runQuery 会因 hash 未变永久早退,推荐再不刷新。
   */
  private onIndexState(state: EmbeddingIndexState): void {
    const becameReady = state === 'ready' && this.indexState !== 'ready';
    this.indexState = state;
    if (becameReady) {
      this.lastHash = ''; // 失效去重守卫:同段落也要按新索引重查
      this.scheduleQuery();
    }
    this.bump();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.unsubProgress?.();
    this.unsubProgress = null;
    this.editor = null;
  }

  // ============================================================
  // 触发链路
  // ============================================================

  private scheduleQuery(): void {
    // 索引未就绪时连 debounce 都不挂,彻底零开销。
    if (this.indexState !== 'ready') {
      logger.info('scheduleQuery skip: index not ready', { indexState: this.indexState });
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runQuery();
    }, DEBOUNCE_MS);
  }

  private async runQuery(): Promise<void> {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const extracted = extractFromEditor(model, editor.getPosition()?.lineNumber ?? 1);
    if (!extracted) {
      // 诊断:段落抽取返回 null(trim 后 <30 字符)→ 不查。脱敏:只打行数/光标行。
      logger.info('runQuery skip: paragraph too short', {
        lang: model.getLanguageId(),
        lineCount: model.getLineCount(),
        cursorLine: editor.getPosition()?.lineNumber ?? -1,
      });
      return;
    }
    if (extracted.hash === this.lastHash) {
      logger.info('runQuery skip: unchanged (hash guard)', { hash: extracted.hash });
      return;
    }

    this.lastHash = extracted.hash;
    const turn = ++this.turnId;
    this.loading = true;
    this.bump();
    logger.info('runQuery send', { hash: extracted.hash, textChars: extracted.text.length });

    try {
      const res = await api.zotero.queryRecommendation({
        paragraph: extracted.text,
        lang: detectParagraphLang(model.getLanguageId()),
        filePath: model.uri.path,
      });
      // 过期响应(用户已移到新段落)丢弃。
      if (turn !== this.turnId || res.paragraphHash !== this.lastHash) {
        logger.info('runQuery drop stale', {
          staleTurn: turn !== this.turnId,
          staleHash: res.paragraphHash !== this.lastHash,
        });
        return;
      }
      logger.info('runQuery result', {
        items: res.items.length,
        scores: res.scores?.length ?? 0,
        degraded: res.degraded ?? 'none',
      });
      // 仅在本次带回 scores 时更新缓存,查询失败/无 scores 保留上次,@cite 下拉不瞬间失序。
      if (res.scores) {
        this.citationScores = new Map(res.scores.map((s) => [s.citationKey, s.score]));
      }
      this.items = res.items;
      this.loading = false;
      this.bump();
    } catch (err) {
      logger.warn('recommendation query failed', err);
      if (turn === this.turnId) {
        this.loading = false;
        this.bump();
      }
    }
  }

  // ============================================================
  // 插入引用(面板点击)—— 复用 citationKeyScan 的语法真相源
  // ============================================================

  insertCitation(citationKey: string): void {
    const editor = this.editor;
    const model = editor?.getModel();
    const pos = editor?.getPosition();
    if (!editor || !model || !pos) return;

    const text = formatCitationInsert(citationKey, model.getLanguageId());
    editor.executeEdits('zotero-recommend-insert', [
      {
        range: {
          startLineNumber: pos.lineNumber,
          startColumn: pos.column,
          endLineNumber: pos.lineNumber,
          endColumn: pos.column,
        },
        text,
      },
    ]);
    editor.setPosition({ lineNumber: pos.lineNumber, column: pos.column + text.length });
    editor.focus();
  }

  // ============================================================
  // 订阅(useSyncExternalStore 友好)
  // ============================================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RecommendationState {
    return this.stateSnapshot;
  }

  /**
   * @cite 补全下拉的语义重排数据:当前段落对全库可引用文献的相关度分
   * (citationKey → score)。复用 标尺5 最近一次段落嵌入,键入热路径纯内存
   * 同步读、零 IPC。null(未开 / 未 ready / 尚未嵌段)→ 下拉回落现状排序。
   */
  getCitationRanking(): Map<string, number> | null {
    return this.citationScores;
  }

  private bump(): void {
    this.stateSnapshot = { indexState: this.indexState, items: this.items, loading: this.loading };
    for (const l of this.listeners) l();
  }
}

let singleton: ActiveRecommendationService | null = null;

export function getActiveRecommendationService(): ActiveRecommendationService {
  if (!singleton) singleton = new ActiveRecommendationService();
  return singleton;
}
