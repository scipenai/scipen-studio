/**
 * @file LocalReplica API - Local Replica Sync API Module
 * @description Provides IPC interfaces for bidirectional sync between Overleaf projects and local directories
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener } from './_shared';

export interface LocalReplicaConfig {
  projectId: string;
  projectName: string;
  localPath: string;
  enabled: boolean;
  customIgnorePatterns?: string[];
}

export interface LocalReplicaSyncProgress {
  phase: 'scanning' | 'downloading' | 'uploading' | 'complete' | 'error';
  current: number;
  total: number;
  currentFile?: string;
  error?: string;
}

export const localReplicaApi = {
  /**
   * Initialize local replica configuration
   * @sideeffect Sets up sync configuration and may start initial sync
   */
  init: (config: LocalReplicaConfig) => ipcRenderer.invoke(IpcChannel.LocalReplica_Init, config),

  getConfig: () => ipcRenderer.invoke(IpcChannel.LocalReplica_GetConfig),

  /**
   * Enable/disable local replica sync
   * @sideeffect Starts or stops sync operations
   */
  setEnabled: (enabled: boolean) => ipcRenderer.invoke(IpcChannel.LocalReplica_SetEnabled, enabled),

  /**
   * Sync from remote to local
   * @sideeffect Downloads and updates local files
   */
  syncFromRemote: () => ipcRenderer.invoke(IpcChannel.LocalReplica_SyncFromRemote),

  /**
   * Sync from local to remote
   * @sideeffect Uploads local changes to Overleaf
   */
  syncToRemote: () => ipcRenderer.invoke(IpcChannel.LocalReplica_SyncToRemote),

  /**
   * Start watching local file changes
   * @sideeffect Registers file system watchers
   */
  startWatching: () => ipcRenderer.invoke(IpcChannel.LocalReplica_StartWatching),

  /**
   * Stop watching local file changes
   * @sideeffect Unregisters file system watchers
   */
  stopWatching: () => ipcRenderer.invoke(IpcChannel.LocalReplica_StopWatching),

  isWatching: () => ipcRenderer.invoke(IpcChannel.LocalReplica_IsWatching),

  /**
   * Listen to sync progress events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onSyncProgress: createSafeListener<LocalReplicaSyncProgress>(
    IpcChannel.LocalReplica_SyncProgress
  ),
};
