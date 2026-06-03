/**
 * @file InlineEditClient — thin renderer wrapper over `window.api.ai.inlineEdit*`.
 *
 * Keeps the AbortController-free invoke shape simple: callers receive a
 * `{ turnId }` from `start()` and subscribe to deltas/complete/error via
 * the returned `unsubscribe` closures. No global state; consumers manage
 * their own listener lifecycle.
 *
 * Type strategy: types are duplicated locally because renderer tsconfig
 * doesn't include preload paths, and they're tiny / stable.
 */

export interface InlineEditStartParams {
  instruction: string;
  selectedText: string;
  language: string;
  fileLabel?: string;
  surroundingContext?: string;
}

export interface InlineEditDeltaEvent {
  turnId: string;
  delta: string;
}

export interface InlineEditCompleteEvent {
  turnId: string;
  fullText: string;
}

export interface InlineEditErrorEvent {
  turnId: string;
  message: string;
  code?: 'aborted' | 'not_configured' | 'provider_error';
}

/* eslint-disable @typescript-eslint/no-explicit-any */

class InlineEditClientImpl {
  private get api(): any {
    const electron = (window as unknown as { electron?: { ai?: any } }).electron;
    if (!electron?.ai) {
      throw new Error('window.electron.ai is not available — preload bridge missing');
    }
    return electron.ai;
  }

  start(params: InlineEditStartParams): Promise<{ turnId: string }> {
    return this.api.inlineEditStart(params);
  }

  cancel(turnId: string): Promise<{ ok: boolean }> {
    return this.api.inlineEditCancel(turnId);
  }

  onDelta(cb: (evt: InlineEditDeltaEvent) => void): () => void {
    return this.api.onInlineEditDelta(cb);
  }

  onComplete(cb: (evt: InlineEditCompleteEvent) => void): () => void {
    return this.api.onInlineEditComplete(cb);
  }

  onError(cb: (evt: InlineEditErrorEvent) => void): () => void {
    return this.api.onInlineEditError(cb);
  }
}

export const inlineEditClient = new InlineEditClientImpl();
