/**
 * @file ZoteroEventBus —— 主进程 bib 事件总线
 * @description Orchestrator emit 事件后 (a) 广播到每个 renderer window
 *              (Zotero_Event 通道),(b) 触发 main 内部 listener。后者让
 *              BibTexSyncService 这种主进程组件无需 IPC round-trip 就能听到
 *              index 变化。
 *
 *              `Broadcaster` 是测试 seam:生产环境 fan-out 到所有活 BrowserWindow。
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
        // 单个订阅者炸不能拖垮总线;打到 stderr 就够,这里不引 LoggerService 依赖。
        // eslint-disable-next-line no-console
        console.error('[ZoteroEventBus] in-process listener threw', err);
      }
    }
  }

  /** 注册 main 内部 listener;返回取订函数。 */
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
