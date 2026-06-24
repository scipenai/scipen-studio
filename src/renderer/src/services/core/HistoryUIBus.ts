/**
 * @file HistoryUIBus - imperative open events for history dialogs.
 *
 * Dialogs live as siblings of `<CommandPalette>` in `App.tsx`; the palette
 * (and any other call site — future keybindings, status bar buttons, etc.)
 * fires through this bus and the dialog component owns its own open/close
 * state. Keeps the prop drilling at zero.
 */

import { Emitter, type Event } from '../../../../../shared/utils';

export type HistoryBrowserTab = 'labels' | 'sessions';

class HistoryUIBus {
  private readonly _openCreateLabel = new Emitter<void>();
  readonly onOpenCreateLabel: Event<void> = this._openCreateLabel.event;

  /**
   * Unified browser open event — fires with the initially selected tab.
   * Sidebar entries set `'labels'` or `'sessions'` so the user lands on the
   * familiar surface; once the dialog is mounted the user can switch tabs
   * inside without re-emitting.
   */
  private readonly _openBrowser = new Emitter<HistoryBrowserTab>();
  readonly onOpenBrowser: Event<HistoryBrowserTab> = this._openBrowser.event;

  /**
   * Cache-invalidation broadcasts — fired by the write sites
   * (`NewLabelDialog` after `createLabel` succeeds; `ChatStreamStore`
   * after a SNACA tool step is persisted). Any open browser refetches
   * the affected tab without the user having to close and reopen.
   *
   * Both events are `void` — listeners are expected to call back into
   * the `api.history.list*` paths to pull fresh data, so passing a delta
   * payload would force every listener to reconcile, which is more
   * brittle than refetching the small list.
   */
  private readonly _labelsChanged = new Emitter<void>();
  readonly onLabelsChanged: Event<void> = this._labelsChanged.event;

  private readonly _sessionsChanged = new Emitter<void>();
  readonly onSessionsChanged: Event<void> = this._sessionsChanged.event;

  openCreateLabel(): void {
    this._openCreateLabel.fire();
  }

  openBrowseLabels(): void {
    this._openBrowser.fire('labels');
  }

  openBrowseSessions(): void {
    this._openBrowser.fire('sessions');
  }

  fireLabelsChanged(): void {
    this._labelsChanged.fire();
  }

  fireSessionsChanged(): void {
    this._sessionsChanged.fire();
  }
}

export const historyUIBus = new HistoryUIBus();
