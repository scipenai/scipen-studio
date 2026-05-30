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

  private listeners = new Set<Listener>();
  private stateSnapshot: RecommendationState = { indexState: 'disabled', items: [], loading: false };
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
        this.indexState = status.state;
        this.bump();
      });
      void api.zotero.getEmbeddingStatus().then((s) => {
        this.indexState = s.state;
        this.bump();
      });
    }
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
    if (this.indexState !== 'ready') return;
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
    if (!extracted) return; // 段落太短 → 不查
    if (extracted.hash === this.lastHash) return; // 段落没变 → 零 IPC

    this.lastHash = extracted.hash;
    const turn = ++this.turnId;
    this.loading = true;
    this.bump();

    try {
      const res = await api.zotero.queryRecommendation({
        paragraph: extracted.text,
        lang: detectParagraphLang(model.getLanguageId()),
        filePath: model.uri.path,
      });
      // 过期响应(用户已移到新段落)丢弃。
      if (turn !== this.turnId || res.paragraphHash !== this.lastHash) return;
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
