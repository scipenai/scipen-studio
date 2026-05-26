/**
 * @file ZoteroEventBus — broadcast bib events to every renderer window
 * @description Thin wrapper around `BrowserWindow.getAllWindows().send`
 *              that the orchestrator drives. Kept as a class so tests
 *              can inject a fake broadcaster without touching electron.
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../../shared/ipc/channels';
import type { ZoteroEventDTO } from '../../../../shared/types/zotero-events';

/** Test seam — production fans out to every live BrowserWindow. */
export type Broadcaster = (channel: string, payload: unknown) => void;

const defaultBroadcaster: Broadcaster = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

export class ZoteroEventBus {
  private readonly broadcaster: Broadcaster;

  constructor(broadcaster: Broadcaster = defaultBroadcaster) {
    this.broadcaster = broadcaster;
  }

  emit(event: ZoteroEventDTO): void {
    this.broadcaster(IpcChannel.Zotero_Event, event);
  }
}

let singleton: ZoteroEventBus | null = null;

export function getZoteroEventBus(): ZoteroEventBus {
  if (!singleton) {
    singleton = new ZoteroEventBus();
  }
  return singleton;
}
