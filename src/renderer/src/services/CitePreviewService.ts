/**
 * @file CitePreviewService — `\cite{key}` hover preview. Uses a custom Monaco
 *   IContentWidget (not the native hover's IMarkdownString, which can't reliably
 *   render data: images) to show title/authors/year + abstract + paper screenshot.
 *   Screenshot is async (CiteShotService), guarded by currentItemKey to prevent
 *   rebuild/race; debounce avoids triggering loadPdf on quick mouseover.
 *   Lifecycle mirrors MathPreviewService.
 */

import type * as Monaco from 'monaco-editor';
import type { ZoteroItemDTO } from '../../../../shared/types/zotero';
import { findCitationKeyAt } from '../components/editor/citationKeyScan';
import { t } from '../locales';
import { getZoteroBibMirror } from './zotero/ZoteroBibMirror';
import { type CiteShotResult, getCiteShotService } from './CiteShotService';
import { createLogger } from './LogService';

const logger = createLogger('CitePreviewService');

const SHOT_DEBOUNCE_MS = 180;

const CARD_STYLE = `
.cite-preview-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: var(--shadow-md), 0 0 0 1px var(--color-border-subtle);
  color: var(--color-text-primary);
  font-family: 'Inter', system-ui, sans-serif;
  width: 360px;
  overflow: hidden;
}
.cite-preview-meta { padding: 10px 12px 8px; }
.cite-preview-title { font-size: 13px; font-weight: 600; line-height: 1.35; }
.cite-preview-sub { font-size: 11px; color: var(--color-text-muted); margin-top: 2px; }
.cite-preview-abstract {
  font-size: 11.5px; line-height: 1.5; color: var(--color-text-secondary);
  margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 5;
  -webkit-box-orient: vertical; overflow: hidden;
}
.cite-shot:empty { display: none; }
.cite-shot { border-top: 1px solid var(--color-border-subtle); background: var(--color-bg-tertiary); }
.cite-shot-img { display: block; width: 100%; height: auto; }
.cite-shot-note {
  padding: 10px 12px; font-size: 11px; color: var(--color-text-muted); text-align: center;
}
`;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

function buildMetaHtml(entry: ZoteroItemDTO): string {
  const keyLabel = entry.citationKey ?? entry.itemKey;
  const sub = [entry.creatorsLabel, entry.year ? String(entry.year) : '', keyLabel]
    .filter((x): x is string => Boolean(x))
    .map(escapeHtml)
    .join(' · ');
  const title = entry.title
    ? `<div class="cite-preview-title">${escapeHtml(entry.title)}</div>`
    : '';
  const abstract = entry.abstractNote
    ? `<div class="cite-preview-abstract">${escapeHtml(entry.abstractNote)}</div>`
    : '';
  return `${title}<div class="cite-preview-sub">${sub}</div>${abstract}`;
}

function buildShotHtml(result: CiteShotResult): string {
  if (result.status === 'ok') return `<img class="cite-shot-img" src="${result.dataUrl}" alt="" />`;
  const note =
    result.status === 'no-pdf' ? t('zoteroCiteHover.noPdf') : t('zoteroCiteHover.shotFailed');
  return `<div class="cite-shot-note">${escapeHtml(note)}</div>`;
}

function loadingShotHtml(): string {
  return `<div class="cite-shot-note">${escapeHtml(t('zoteroCiteHover.loadingShot'))}</div>`;
}

class CiteHoverWidget implements Monaco.editor.IContentWidget {
  static readonly ID = 'cite.preview.widget';
  private readonly domNode: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly shotEl: HTMLElement;
  private position: Monaco.editor.IContentWidgetPosition | null = null;

  constructor() {
    this.domNode = document.createElement('div');
    this.domNode.style.cssText =
      'position:absolute;z-index:1000;pointer-events:none;transition:opacity .1s ease-in-out;opacity:0;';
    this.domNode.innerHTML = `<style>${CARD_STYLE}</style><div class="cite-preview-card"><div class="cite-preview-meta"></div><div class="cite-shot"></div></div>`;
    this.metaEl = this.domNode.querySelector('.cite-preview-meta') as HTMLElement;
    this.shotEl = this.domNode.querySelector('.cite-shot') as HTMLElement;
  }

  getId(): string {
    return CiteHoverWidget.ID;
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  getPosition(): Monaco.editor.IContentWidgetPosition | null {
    return this.position;
  }

  isVisible(): boolean {
    return this.position !== null;
  }

  /** Render card body (title/authors/abstract) + initial loading state for shot, then position and show. */
  showFor(position: Monaco.IPosition, entry: ZoteroItemDTO): void {
    this.metaEl.innerHTML = buildMetaHtml(entry);
    this.shotEl.innerHTML = loadingShotHtml();
    this.position = { position, preference: [1, 2] }; // ABOVE, BELOW
    this.domNode.style.opacity = '1';
  }

  /** After shot resolves, replace only the shot child node, not the whole card. */
  setShot(html: string): void {
    this.shotEl.innerHTML = html;
  }

  hide(): void {
    this.position = null;
    this.domNode.style.opacity = '0';
  }
}

export class CitePreviewService {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private widget: CiteHoverWidget | null = null;
  private disposables: Monaco.IDisposable[] = [];
  private shotTimer: ReturnType<typeof setTimeout> | null = null;
  private currentItemKey: string | null = null;

  initialize(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void {
    this.editor = editor;
    this.monaco = monaco;
    this.widget = new CiteHoverWidget();
    editor.addContentWidget(this.widget);
    this.disposables.push(
      editor.onMouseMove((e) => this.onMouseMove(e)),
      editor.onMouseLeave(() => this.hideWidget())
    );
  }

  dispose(): void {
    this.clearTimer();
    if (this.editor && this.widget) this.editor.removeContentWidget(this.widget);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    getCiteShotService().dispose();
    this.editor = null;
    this.monaco = null;
    this.widget = null;
    this.currentItemKey = null;
  }

  private onMouseMove(e: Monaco.editor.IEditorMouseEvent): void {
    if (!this.editor || !this.monaco || !this.widget) return;
    if (e.target.type !== this.monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) {
      this.hideWidget();
      return;
    }
    const model = this.editor.getModel();
    if (!model) {
      this.hideWidget();
      return;
    }
    const key = findCitationKeyAt(model, e.target.position, model.getLanguageId());
    const entry = key ? lookupKey(key) : undefined;
    if (!entry) {
      this.hideWidget();
      return;
    }
    this.showFor(e.target.position, entry);
  }

  private showFor(position: Monaco.IPosition, entry: ZoteroItemDTO): void {
    if (entry.itemKey === this.currentItemKey) return; // same paper: already shown, don't rebuild/restart shot
    this.currentItemKey = entry.itemKey;
    this.widget!.showFor(position, entry);
    this.editor!.layoutContentWidget(this.widget!);
    this.scheduleShot(entry.itemKey);
  }

  private scheduleShot(itemKey: string): void {
    this.clearTimer();
    this.shotTimer = setTimeout(() => void this.loadShot(itemKey), SHOT_DEBOUNCE_MS);
  }

  private async loadShot(itemKey: string): Promise<void> {
    let result: CiteShotResult;
    try {
      result = await getCiteShotService().getShot(itemKey);
    } catch (err) {
      logger.warn('cite shot load failed', { itemKey, error: String(err) });
      return;
    }
    if (this.currentItemKey !== itemKey || !this.widget?.isVisible()) return;
    this.widget.setShot(buildShotHtml(result));
    this.editor?.layoutContentWidget(this.widget);
  }

  private hideWidget(): void {
    if (this.currentItemKey === null) return; // already hidden, avoid layout thrash on every mousemove
    this.currentItemKey = null;
    this.clearTimer();
    this.widget?.hide();
    if (this.widget) this.editor?.layoutContentWidget(this.widget);
  }

  private clearTimer(): void {
    if (this.shotTimer) {
      clearTimeout(this.shotTimer);
      this.shotTimer = null;
    }
  }
}

function lookupKey(key: string): ZoteroItemDTO | undefined {
  const mirror = getZoteroBibMirror();
  return mirror.getByCitationKey(key) ?? mirror.getByItemKey(key);
}

export const citePreviewService = new CitePreviewService();
