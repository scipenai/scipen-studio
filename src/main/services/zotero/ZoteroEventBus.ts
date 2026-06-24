/**
 * @file ZoteroEventBus — main-process bib event bus
 * @description After the orchestrator emits an event, the bus (a)
 *              broadcasts it to every renderer window (Zotero_Event
 *              channel) and (b) fires main-process listeners. The latter
 *              lets components like BibTexSyncService listen for index
 *              changes without an IPC round-trip.
 *
 *              `Broadcaster` is a test seam: in production it fans out to
 *              every live BrowserWindow.
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import type { ZoteroEventDTO } from '../../../../shared/types/zotero-events';

export type Broadcaster = (channel: string, payload: unknown) => void;
type Listener = (event: ZoteroEventDTO) => void;

const defaultBroadcaster: Broadcaster = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

export class ZoteroEventBus {
  private readonly broadcaster: Broadcaster;
  private readonly listeners = new Set<Listener>();

  constructor(broadcaster: Broadcaster = defaultBroadcaster) {
    this.broadcaster = broadcaster;
  }

  emit(event: ZoteroEventDTO): void {
    this.broadcaster(IpcChannel.Zotero_Event, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // One throwing subscriber must not take down the bus; stderr is
        // enough here — avoid pulling in LoggerService.
        // eslint-disable-next-line no-console
        console.error('[ZoteroEventBus] in-process listener threw', err);
      }
    }
  }

  /** Register a main-process listener; returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

let singleton: ZoteroEventBus | null = null;

export function getZoteroEventBus(): ZoteroEventBus {
  if (!singleton) {
    singleton = new ZoteroEventBus();
  }
  return singleton;
}
