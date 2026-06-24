/**
 * @file ActiveRecommendationService -- M3 ruler-5 renderer-side recommendation
 * orchestration singleton.
 *
 * Responsibilities: holds the current Monaco editor reference, listens for
 * edit/cursor changes -> debounce 1.5s -> extracts current paragraph ->
 * paragraph-hash guard (skip if unchanged) -> IPC query to main
 * (embed+cosine+rerank) -> turnId discards stale responses -> exposes state to
 * **leaf** panels via useSyncExternalStore.
 *
 * Jank red line ([[project-studio-zotero-active-jank]]): listeners are
 * independent of high-frequency setupContentChangeTracking; debounce + hash
 * guard ensure zero IPC when idle / unchanged; state subscription lives only
 * in leaf components, never at the App root. Only fires a query when the
 * embedding index state==='ready' (silent under disabled/no-key/building).
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

/** How long the editor must idle before we query (prevents thrashing the API mid-typing). */
const DEBOUNCE_MS = 1500;

export interface RecommendationState {
  /** Embedding index state; drives panel hints (configuring / building / ready). */
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
  /** Relevance scores of current paragraph against all citable refs (citationKey -> score), feeds @cite dropdown semantic reranking. */
  private citationScores: Map<string, number> | null = null;

  private listeners = new Set<Listener>();
  private stateSnapshot: RecommendationState = {
    indexState: 'disabled',
    items: [],
    loading: false,
  };
  private unsubProgress: (() => void) | null = null;

  // ============================================================
  // Lifecycle
  // ============================================================

  /** Called when the editor mounts (EditorPane handleEditorMount). Registers listeners + pulls initial state. */
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
   * Unified entry for index-state changes. **Flipping to ready** means the
   * index was just rebuilt/updated (manual rebuild / provider / key change all
   * route through here); the renderer-cached "last queried paragraph hash"
   * and "library-wide relevance scores" are stale -- must clear lastHash to
   * release the dedup guard and proactively re-fire one query, otherwise if
   * the cursor stays in the same paragraph runQuery will early-exit forever
   * on the unchanged hash and recommendations never refresh.
   */
  private onIndexState(state: EmbeddingIndexState): void {
    const becameReady = state === 'ready' && this.indexState !== 'ready';
    this.indexState = state;
    if (becameReady) {
      this.lastHash = ''; // Invalidate dedup guard: same paragraph must re-query against the new index
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
  // Trigger pipeline
  // ============================================================

  private scheduleQuery(): void {
    // When the index isn't ready, don't even arm the debounce -- truly zero overhead.
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
      // Diagnostic: paragraph extraction returned null (trimmed <30 chars) -> skip. Sanitized: only log line counts / cursor line.
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
      // Stale response (user already moved to a new paragraph) -- discard.
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
      // Only update cache when this turn carried scores; on query failure / no scores keep prior so @cite dropdown doesn't suddenly lose ordering.
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
  // Insert citation (panel click) -- reuse citationKeyScan as the syntax source of truth
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
  // Subscription (useSyncExternalStore friendly)
  // ============================================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RecommendationState {
    return this.stateSnapshot;
  }

  /**
   * Semantic reranking data for the @cite completion dropdown: relevance of
   * current paragraph against all citable library refs (citationKey -> score).
   * Reuses the most recent paragraph embedding from ruler-5; the keystroke hot
   * path reads pure in-memory, zero IPC. null (disabled / not ready / no
   * paragraph yet embedded) -> dropdown falls back to its existing ordering.
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
