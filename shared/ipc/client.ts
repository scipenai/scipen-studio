/**
 * @file IPC Client - Type-safe IPC communication utilities
 * @description Provides tRPC-like experience for renderer process IPC calls
 * @depends ipc/types
 */

import type {
  IPCChannel,
  IPCEventChannel,
  IPCEventData,
  IPCHandlers,
  IPCParams,
  IPCResult,
} from './types';

// ====== Type Utilities ======

export type AllIPCChannels = keyof IPCHandlers;

/**
 * Type-safe IPC handler definition for main process
 */
export type IPCHandler<T extends IPCChannel> = (...args: IPCParams<T>) => Promise<IPCResult<T>>;

/**
 * Type-safe IPC event listener definition
 */
export type IPCEventListener<T extends IPCEventChannel> = (data: IPCEventData<T>) => void;

// ====== Renderer Process IPC Client ======

/**
 * Type-safe IPC invoke function
 * @throws {Error} When IPC is not available (not in Electron renderer process)
 */
export async function ipc<T extends IPCChannel>(
  channel: T,
  ...args: IPCParams<T>
): Promise<IPCResult<T>> {
  const win =
    typeof globalThis !== 'undefined'
      ? (globalThis as typeof globalThis & {
          require?: (module: string) => { ipcRenderer?: unknown };
        })
      : undefined;
  const ipcRenderer = win?.require?.('electron')?.ipcRenderer as
    | { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
    | undefined;

  if (!ipcRenderer) {
    throw new Error(`IPC not available: ${channel}`);
  }

  return ipcRenderer.invoke(channel, ...args) as Promise<IPCResult<T>>;
}

/**
 * Type-safe IPC event subscription
 * @returns Unsubscribe function
 */
export function onIPCEvent<T extends IPCEventChannel>(
  channel: T,
  listener: IPCEventListener<T>
): () => void {
  type IpcRenderer = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  };
  const win =
    typeof globalThis !== 'undefined'
      ? (globalThis as typeof globalThis & {
          require?: (module: string) => { ipcRenderer?: IpcRenderer };
        })
      : undefined;
  const ipcRenderer = win?.require?.('electron')?.ipcRenderer;

  if (!ipcRenderer) {
    console.warn(`IPC not available for event: ${channel}`);
    return () => {};
  }

  const wrappedListener = (_event: unknown, data: IPCEventData<T>) => {
    listener(data);
  };

  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

/**
 * Runtime channel name validator
 */
export function isValidChannel(channel: string): channel is IPCChannel {
  const validChannels: string[] = [
    'open-project',
    'read-file',
    'write-file',
    'create-file',
    'create-folder',
    'delete-file',
    'rename-file',
    'copy-file',
    'move-file',
    'refresh-file-tree',
    'path-exists',
    'get-file-stats',
    'show-item-in-folder',
    'select-files',
    'compile-latex',
    'synctex-forward',
    'synctex-backward',
    'open-external',
    'get-app-version',
    'get-platform',
    'overleaf:init',
    'overleaf:test-connection',
    'overleaf:login',
    'overleaf:get-projects',
    'overleaf:compile',
    'overleaf:stop-compile',
    'overleaf:is-logged-in',
    'overleaf:get-cookies',
    'knowledge:initialize',
    'knowledge:update-config',
    'knowledge:create-library',
    'knowledge:get-libraries',
    'knowledge:get-library',
    'knowledge:update-library',
    'knowledge:delete-library',
    'knowledge:add-document',
    'knowledge:add-text',
    'knowledge:get-document',
    'knowledge:get-documents',
    'knowledge:delete-document',
    'knowledge:reprocess-document',
    'knowledge:search',
    'knowledge:query',
    'knowledge:get-task',
    'knowledge:get-queue-stats',
    'knowledge:test-embedding',
    'knowledge:diagnostics',
    'knowledge:rebuild-fts',
    'knowledge:generate-embeddings',
    'knowledge:get-advanced-config',
    'knowledge:set-advanced-config',
    'knowledge:search-enhanced',
    'knowledge:select-files',
    'agent:get-available',
    'agent:pdf2latex',
    'agent:review',
    'agent:paper2beamer',
    'agent:list-templates',
    'agent:kill',
    'agent:sync-vlm-config',
    'agent:create-temp-file',
    'agent:set-claude-settings',
  ];

  return validChannels.includes(channel);
}
