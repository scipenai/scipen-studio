/**
 * @file InlineEditController — Ctrl+K Monaco overlay orchestrator.
 *
 * Lifecycle (single active session per app):
 *   1. `trigger(editor)`  → user hit Ctrl+K with a non-empty selection.
 *                           Mount a Content Widget anchored above the
 *                           selection, focus the instruction input.
 *   2. user types + Enter → `handleSubmit()` calls `inlineEditClient.start`,
 *                           subscribes to delta/complete/error events
 *                           filtered by `turnId`.
 *   3. deltas arrive      → appended to widget's ghost-text panel.
 *   4. complete fires     → widget enters "accept" state, Tab confirms.
 *   5. Tab (accept)       → `editor.executeEdits` replaces the selection
 *                           with the sanitised full text (single undo).
 *   6. Esc (dismiss)      → cancel the turn upstream + tear down widget.
 *
 * Concurrency: at most one widget at a time. A second Ctrl+K while one is
 * open re-focuses the existing input instead of stacking.
 *
 * Widget is a plain DOM IContentWidget (mirrors `MathHoverWidget` style)
 * — keeps Monaco's position math in charge and avoids dragging React's
 * reconciliation into a non-React island.
 */

import type * as Monaco from 'monaco-editor';
import { t } from '../../locales';
import { createLogger } from '../LogService';
import {
  inlineEditClient,
  type InlineEditCompleteEvent,
  type InlineEditDeltaEvent,
  type InlineEditErrorEvent,
} from './InlineEditClient';

const logger = createLogger('InlineEdit');

/**
 * Surrounding context window (± lines around selection). Capped further
 * by the main-side schema; this is the renderer-side guardrail.
 */
const SURROUNDING_CONTEXT_LINES = 20;

/** Hard cap on selection size — matches main-side IPC schema (100KB). */
const MAX_SELECTION_BYTES = 100_000;

type WidgetState = 'idle' | 'streaming' | 'complete' | 'error';

interface ActiveSession {
  editor: Monaco.editor.ICodeEditor;
  widget: InlineEditWidget;
  selection: Monaco.IRange;
  selectedText: string;
  language: string;
  fileLabel?: string;
  surroundingContext?: string;
  turnId: string | null;
  acceptedText: string;
  unsubs: Array<() => void>;
}

class InlineEditControllerImpl {
  private active: ActiveSession | null = null;

  /** Bind global event listeners once (lazy on first trigger). */
  private installed = false;

  /**
   * Entry point from the `inlineEdit` shortcut handler. No-op if no
   * selection, no editor, or selection too large.
   */
  trigger(editor: Monaco.editor.ICodeEditor, opts?: { fileLabel?: string }): void {
    this.ensureInstalled();

    if (this.active) {
      this.active.widget.focusInput();
      return;
    }

    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) return;
    if (selection.isEmpty()) {
      logger.info('inline edit: empty selection, skipping');
      return;
    }

    const selectedText = model.getValueInRange(selection);
    if (selectedText.length > MAX_SELECTION_BYTES) {
      logger.warn('inline edit: selection too large', { length: selectedText.length });
      return;
    }

    const surroundingContext = extractSurrounding(model, selection);
    const language = model.getLanguageId();

    const widget = new InlineEditWidget({
      editor,
      anchor: { lineNumber: selection.startLineNumber, column: selection.startColumn },
      onSubmit: (instruction) => this.handleSubmit(instruction),
      onCancel: () => this.dismiss('user'),
      onAccept: () => this.acceptCurrentTurn(),
    });

    editor.addContentWidget(widget);

    this.active = {
      editor,
      widget,
      selection,
      selectedText,
      language,
      fileLabel: opts?.fileLabel,
      surroundingContext,
      turnId: null,
      acceptedText: '',
      unsubs: [],
    };

    // Defer focus until Monaco has positioned the widget so the input
    // doesn't steal focus mid-layout.
    setTimeout(() => widget.focusInput(), 0);
  }

  /** Hide and tear down any active widget. Idempotent. */
  dismiss(reason: 'user' | 'accepted' | 'error'): void {
    const session = this.active;
    if (!session) return;
    this.active = null;

    // Cancel upstream turn if still in flight.
    if (session.turnId && session.widget.state === 'streaming') {
      inlineEditClient.cancel(session.turnId).catch((err) => {
        logger.warn('cancel rpc failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    for (const off of session.unsubs) off();
    session.unsubs = [];

    try {
      session.editor.removeContentWidget(session.widget);
    } catch {
      /* widget already detached */
    }
    session.widget.dispose();

    logger.info(`dismissed (${reason})`);
  }

  // ============ Internals ============

  /**
   * Subscribe to IPC events once, fan them out to the active session
   * based on turnId. Idempotent.
   */
  private ensureInstalled(): void {
    if (this.installed) return;
    this.installed = true;
    inlineEditClient.onDelta((e) => this.routeDelta(e));
    inlineEditClient.onComplete((e) => this.routeComplete(e));
    inlineEditClient.onError((e) => this.routeError(e));
  }

  private async handleSubmit(instruction: string): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (!instruction.trim()) return;
    if (session.widget.state === 'streaming' || session.widget.state === 'complete') {
      // Another submit while one is already pending — ignore. UI should
      // disable the input but defend in depth.
      return;
    }

    session.widget.setState('streaming');
    session.widget.clearGhost();

    try {
      const { turnId } = await inlineEditClient.start({
        instruction,
        selectedText: session.selectedText,
        language: session.language,
        fileLabel: session.fileLabel,
        surroundingContext: session.surroundingContext,
      });
      session.turnId = turnId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.widget.setError(message);
    }
  }

  private acceptCurrentTurn(): void {
    const session = this.active;
    if (!session) return;
    if (session.widget.state !== 'complete') return;

    const text = session.acceptedText;
    if (!text) {
      this.dismiss('accepted');
      return;
    }

    // Single, undoable edit. Range = original selection so cursor lands
    // at the end of the replacement.
    session.editor.executeEdits('inline-edit-accept', [
      {
        range: session.selection,
        text,
        forceMoveMarkers: true,
      },
    ]);
    this.dismiss('accepted');
  }

  private routeDelta(e: InlineEditDeltaEvent): void {
    if (!this.active || this.active.turnId !== e.turnId) return;
    this.active.widget.appendGhost(e.delta);
  }

  private routeComplete(e: InlineEditCompleteEvent): void {
    if (!this.active || this.active.turnId !== e.turnId) return;
    this.active.acceptedText = e.fullText;
    this.active.widget.setComplete(e.fullText);
  }

  private routeError(e: InlineEditErrorEvent): void {
    if (!this.active || this.active.turnId !== e.turnId) return;
    if (e.code === 'aborted') return; // already dismissed by user
    this.active.widget.setError(e.message);
  }
}

export const inlineEditController = new InlineEditControllerImpl();

// ============ Widget ============

interface WidgetConstructorArgs {
  editor: Monaco.editor.ICodeEditor;
  anchor: Monaco.IPosition;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
  onAccept: () => void;
}

class InlineEditWidget implements Monaco.editor.IContentWidget {
  static readonly ID = 'scipen.inlineEdit.widget';

  state: WidgetState = 'idle';

  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly ghostEl: HTMLElement;
  private readonly position: Monaco.editor.IContentWidgetPosition;

  constructor(private readonly args: WidgetConstructorArgs) {
    this.position = {
      position: args.anchor,
      preference: [
        // ABOVE = 1, BELOW = 2; prefer above so the original selection
        // stays visible underneath the widget.
        1, 2,
      ] as Monaco.editor.ContentWidgetPositionPreference[],
    };

    this.root = document.createElement('div');
    this.root.className = 'scipen-inline-edit';
    this.root.style.cssText = WIDGET_STYLES;

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = t('editor.inlineEdit.placeholder');
    this.input.className = 'scipen-inline-edit__input';
    this.input.style.cssText = INPUT_STYLES;

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'scipen-inline-edit__status';
    this.statusEl.style.cssText = STATUS_STYLES;

    this.ghostEl = document.createElement('pre');
    this.ghostEl.className = 'scipen-inline-edit__ghost';
    this.ghostEl.style.cssText = GHOST_STYLES;
    this.ghostEl.style.display = 'none';

    this.root.appendChild(this.input);
    this.root.appendChild(this.statusEl);
    this.root.appendChild(this.ghostEl);

    this.input.addEventListener('keydown', this.handleKeyDown);
  }

  // ----- IContentWidget impl -----

  getId(): string {
    return InlineEditWidget.ID;
  }

  getDomNode(): HTMLElement {
    return this.root;
  }

  getPosition(): Monaco.editor.IContentWidgetPosition {
    return this.position;
  }

  // ----- Public surface -----

  focusInput(): void {
    this.input.focus();
    this.input.select();
  }

  setState(state: WidgetState): void {
    this.state = state;
    switch (state) {
      case 'idle':
        this.statusEl.textContent = '';
        this.input.readOnly = false;
        break;
      case 'streaming':
        this.statusEl.textContent = t('editor.inlineEdit.generating');
        this.input.readOnly = true;
        this.ghostEl.style.display = 'block';
        break;
      case 'complete':
        this.statusEl.textContent = t('editor.inlineEdit.acceptHint');
        this.input.readOnly = true;
        break;
      case 'error':
        this.input.readOnly = false;
        break;
    }
    // readOnly doesn't change focus, but browsers occasionally drop focus on state
    // transitions; proactively ensure the input keeps focus so Tab/Esc reach the
    // widget's keydown handler.
    if (document.activeElement !== this.input) {
      this.input.focus({ preventScroll: true });
    }
  }

  appendGhost(delta: string): void {
    if (this.state !== 'streaming') return;
    this.ghostEl.textContent = (this.ghostEl.textContent ?? '') + delta;
  }

  clearGhost(): void {
    this.ghostEl.textContent = '';
    this.ghostEl.style.display = 'none';
  }

  setComplete(fullText: string): void {
    this.ghostEl.textContent = fullText;
    this.ghostEl.style.display = 'block';
    this.setState('complete');
  }

  setError(message: string): void {
    this.statusEl.textContent = `✗ ${message}`;
    this.statusEl.style.color = 'var(--color-text-error, #ef4444)';
    this.setState('error');
  }

  dispose(): void {
    this.input.removeEventListener('keydown', this.handleKeyDown);
  }

  // ----- Handlers -----

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.args.onCancel();
      return;
    }
    if (e.key === 'Enter' && this.state !== 'streaming' && this.state !== 'complete') {
      e.preventDefault();
      e.stopPropagation();
      const value = this.input.value.trim();
      if (value) this.args.onSubmit(value);
      return;
    }
    if (e.key === 'Tab') {
      // Always intercept Tab to prevent focus escaping the widget; only trigger accept in complete state.
      e.preventDefault();
      e.stopPropagation();
      if (this.state === 'complete') {
        this.args.onAccept();
      }
      return;
    }
  };
}

// ============ Helpers ============

function extractSurrounding(
  model: Monaco.editor.ITextModel,
  selection: Monaco.IRange
): string | undefined {
  const total = model.getLineCount();
  const fromLine = Math.max(1, selection.startLineNumber - SURROUNDING_CONTEXT_LINES);
  const toLine = Math.min(total, selection.endLineNumber + SURROUNDING_CONTEXT_LINES);
  if (toLine <= fromLine) return undefined;
  const lines: string[] = [];
  for (let ln = fromLine; ln <= toLine; ln++) {
    // Skip the selection itself — it's already in the user prompt as
    // "Selected text"; including it twice just wastes tokens.
    if (ln >= selection.startLineNumber && ln <= selection.endLineNumber) continue;
    lines.push(`${String(ln).padStart(4)} | ${model.getLineContent(ln)}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// ============ Styles ============

const WIDGET_STYLES = `
  position: relative;
  z-index: 100;
  min-width: 420px;
  max-width: 640px;
  background: var(--color-bg-elevated, #ffffff);
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 8px;
  font-family: var(--font-family-sans, system-ui), sans-serif;
  font-size: 13px;
  color: var(--color-text-primary, #111827);
`;

const INPUT_STYLES = `
  width: 100%;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--color-bg-primary, #ffffff);
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  outline: none;
  box-sizing: border-box;
`;

const STATUS_STYLES = `
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-secondary, #6b7280);
  min-height: 14px;
`;

const GHOST_STYLES = `
  margin-top: 8px;
  padding: 8px;
  background: var(--color-bg-tertiary, #f3f4f6);
  border-radius: 6px;
  font-family: var(--font-family-mono, ui-monospace), monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
  margin-bottom: 0;
  color: inherit;
`;
