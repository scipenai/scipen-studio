/**
 * @file App/Window/Log/Config/Trace/Dialog IPC Contract
 * @description Application-level types and channel contract
 * @depends ipc/channels
 */

import { IpcChannel } from './channels';

// ====== Window Types ======

export interface WindowInfo {
  id: number;
  projectPath?: string;
  title: string;
}

// ====== Log Types ======

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  details?: unknown;
}

// ====== Dialog Types ======

export interface ConfirmDialogOptions {
  message: string;
  title?: string;
}

export interface MessageDialogOptions {
  message: string;
  type?: 'info' | 'warning' | 'error';
  title?: string;
}

// ====== Auto Update Types ======

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  total: number;
  transferred: number;
}

export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  info?: UpdateInfo;
  progress?: UpdateProgress;
  error?: string;
  currentVersion: string;
}

// ====== Channel Contract ======

export interface IPCAppContract {
  // ============ Window ============
  [IpcChannel.Window_New]: {
    args: [options?: { projectPath?: string }];
    result: number;
  };
  [IpcChannel.Window_GetAll]: {
    args: [];
    result: WindowInfo[];
  };
  [IpcChannel.Window_Close]: {
    args: [];
    result: void;
  };
  [IpcChannel.Window_Focus]: {
    args: [windowId: number];
    result: void;
  };

  // ============ App ============
  [IpcChannel.App_GetVersion]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_GetHomeDir]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_GetAppDataDir]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_OpenExternal]: {
    args: [url: string];
    result: void;
  };

  // ============ Auto Update ============
  [IpcChannel.App_CheckUpdate]: {
    args: [];
    result: UpdateStatus;
  };
  [IpcChannel.App_DownloadUpdate]: {
    args: [];
    result: void;
  };
  [IpcChannel.App_InstallUpdate]: {
    args: [];
    result: void;
  };

  // ============ Log ============
  [IpcChannel.Log_GetPath]: {
    args: [];
    result: string;
  };
  [IpcChannel.Log_OpenFolder]: {
    args: [];
    result: void;
  };
  [IpcChannel.Log_Write]: {
    args: [entries: LogEntry[]];
    result: void;
  };
  [IpcChannel.Log_ExportDiagnostics]: {
    args: [];
    result: string;
  };
  [IpcChannel.Log_Clear]: {
    args: [];
    result: void;
  };
  [IpcChannel.Log_FromRenderer]: {
    args: [
      source: { process: 'renderer'; window?: string; module?: string },
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      data?: unknown[],
    ];
    result: void;
  };

  // ============ Config ============
  [IpcChannel.Config_Get]: {
    args: [key: string];
    result: unknown;
  };
  [IpcChannel.Config_Set]: {
    args: [key: string, value: unknown, notify?: boolean];
    result: void;
  };

  // ============ Trace ============
  [IpcChannel.Trace_Start]: {
    args: [name: string, parentContext?: { traceId: string; spanId: string }];
    result: { traceId: string; spanId: string };
  };
  [IpcChannel.Trace_End]: {
    args: [spanId: string, result?: unknown];
    result: void;
  };
  [IpcChannel.Trace_Get]: {
    args: [traceId: string];
    result: unknown;
  };

  // ============ Dialog ============
  [IpcChannel.Dialog_Confirm]: {
    args: [options: ConfirmDialogOptions];
    result: boolean;
  };
  [IpcChannel.Dialog_Message]: {
    args: [options: MessageDialogOptions];
    result: void;
  };
}
