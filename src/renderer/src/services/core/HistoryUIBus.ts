/**
 * @file HistoryUIBus - imperative open events for history dialogs.
 *
 * Dialogs live as siblings of `<CommandPalette>` in `App.tsx`; the palette
 * (and any other call site — future keybindings, status bar buttons, etc.)
 * fires through this bus and the dialog component owns its own open/close
 * state. Keeps the prop drilling at zero.
 */

import { Emitter, type Event } from '../../../../../shared/utils';

class HistoryUIBus {
  private readonly _openCreateLabel = new Emitter<void>();
  readonly onOpenCreateLabel: Event<void> = this._openCreateLabel.event;

  private readonly _openBrowseLabels = new Emitter<void>();
  readonly onOpenBrowseLabels: Event<void> = this._openBrowseLabels.event;

  private readonly _openBrowseSessions = new Emitter<void>();
  readonly onOpenBrowseSessions: Event<void> = this._openBrowseSessions.event;

  openCreateLabel(): void {
    this._openCreateLabel.fire();
  }

  openBrowseLabels(): void {
    this._openBrowseLabels.fire();
  }

  openBrowseSessions(): void {
    this._openBrowseSessions.fire();
  }
}

export const historyUIBus = new HistoryUIBus();
