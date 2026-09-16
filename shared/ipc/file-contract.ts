/**
 * @file File Operations IPC Contract
 * @description File/Project/Watcher/Cache types and channel contract
 * @depends ipc/channels, ipc/types
 */

import { IpcChannel } from './channels';
import type { FileFilter, FileStats, FileTreeNode, SelectedFile } from './types';

// ====== File Batch Types ======

export interface BatchReadResult {
  path: string;
  success: boolean;
  content?: string;
  error?: string;
}

export interface BatchStatResult {
  path: string;
  success: boolean;
  stats?: FileStats;
  error?: string;
}

export interface BatchExistsResult {
  path: string;
  exists: boolean;
}

export interface BatchWriteResult {
  path: string;
  success: boolean;
  error?: string;
}

// ====== Channel Contract ======
/**
 * A bundled starter template. `id` is stable and doubles as the i18n key
 * (`templates.<id>.name` / `.description`); the main process never ships
 * display text.
 */
export interface ProjectTemplateDTO {
  id: string;
  /** File opened after creation, relative to the project root. */
  mainFile: string;
  engine: 'latex' | 'typst';
  /** False when the first compile needs the network (see templates/README). */
  offline: boolean;
}

/**
 * Outcome of a template scaffold. `cancelled` covers the user dismissing the
 * directory picker — a normal outcome, not an error, so it is not thrown.
 */
export type ProjectCreateFromTemplateResult =
  | { ok: true; projectPath: string; mainFile: string; fileTree: FileTreeNode }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string };

export interface IPCFileContract {
  // ============ Project Management ============
  [IpcChannel.Project_Open]: {
    args: [];
    result: { projectPath: string; fileTree: FileTreeNode } | null;
  };
  [IpcChannel.Project_OpenByPath]: {
    args: [projectPath: string];
    result: { projectPath: string; fileTree: FileTreeNode } | null;
  };
  [IpcChannel.Project_GetRecent]: {
    args: [];
    result: Array<{ path: string; name: string; lastOpened: number; isRemote?: boolean }>;
  };
  [IpcChannel.Project_ListTemplates]: {
    args: [];
    result: ProjectTemplateDTO[];
  };
  [IpcChannel.Project_CreateFromTemplate]: {
    args: [templateId: string, projectName: string];
    result: ProjectCreateFromTemplateResult;
  };

  // ============ File Operations ============
  [IpcChannel.File_Read]: {
    args: [filePath: string];
    result: { content: string; mtime: number };
  };
  [IpcChannel.File_ReadBinary]: {
    args: [filePath: string];
    result: ArrayBuffer;
  };
  [IpcChannel.File_Write]: {
    args: [filePath: string, content: string, expectedMtime?: number];
    result: { success: boolean; conflict?: boolean; currentMtime?: number };
  };
  [IpcChannel.File_Create]: {
    args: [filePath: string, content?: string];
    result: boolean;
  };
  [IpcChannel.Folder_Create]: {
    args: [folderPath: string];
    result: boolean;
  };
  [IpcChannel.File_Delete]: {
    args: [filePath: string, entityType?: string, entityId?: string];
    result: boolean;
  };
  /** Move to trash (recoverable delete) */
  [IpcChannel.File_Trash]: {
    args: [filePath: string];
    result: boolean;
  };
  [IpcChannel.File_Rename]: {
    args: [oldPath: string, newPath: string, entityType?: string, entityId?: string];
    result: boolean;
  };
  [IpcChannel.File_Copy]: {
    args: [srcPath: string, destPath: string];
    result: boolean;
  };
  [IpcChannel.File_Move]: {
    args: [srcPath: string, destPath: string];
    result: boolean;
  };
  [IpcChannel.File_Exists]: {
    args: [filePath: string];
    result: boolean;
  };
  [IpcChannel.File_Stats]: {
    args: [filePath: string];
    result: FileStats | null;
  };
  [IpcChannel.File_ShowInFolder]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.File_OpenPath]: {
    args: [filePath: string];
    result: boolean;
  };
  [IpcChannel.File_Select]: {
    args: [options?: { filters?: FileFilter[]; multiple?: boolean; directory?: boolean }];
    result: SelectedFile[] | null;
  };
  [IpcChannel.File_RefreshTree]: {
    args: [projectPath: string];
    result: { success: boolean; fileTree?: FileTreeNode; error?: string };
  };
  /** Lazy load: resolve directory children */
  [IpcChannel.File_ResolveChildren]: {
    args: [dirPath: string];
    result: { success: boolean; children?: FileTreeNode[]; error?: string };
  };
  /** Background indexing: scan all file paths (for @ completion) */
  [IpcChannel.File_ScanPaths]: {
    args: [projectPath: string];
    result: { success: boolean; paths?: string[]; error?: string };
  };
  [IpcChannel.Clipboard_GetFiles]: {
    args: [];
    result: string[] | null;
  };

  // Batch operations
  [IpcChannel.File_BatchRead]: {
    args: [filePaths: string[]];
    result: BatchReadResult[];
  };
  /** Binary read for engine staging; contents arrive base64-encoded. */
  [IpcChannel.File_BatchReadBinary]: {
    args: [filePaths: string[]];
    result: Array<{ path: string; success: boolean; base64?: string; error?: string }>;
  };
  [IpcChannel.File_BatchStat]: {
    args: [filePaths: string[]];
    result: BatchStatResult[];
  };
  [IpcChannel.File_BatchExists]: {
    args: [filePaths: string[]];
    result: BatchExistsResult[];
  };
  [IpcChannel.File_BatchWrite]: {
    args: [files: Array<{ path: string; content: string }>];
    result: BatchWriteResult[];
  };
  [IpcChannel.File_BatchDelete]: {
    args: [filePaths: string[]];
    result: BatchWriteResult[];
  };

  // ============ File Watcher ============
  [IpcChannel.FileWatcher_Start]: {
    args: [projectPath: string];
    result: { success: boolean; reason?: string };
  };
  [IpcChannel.FileWatcher_Stop]: {
    args: [];
    result: { success: boolean };
  };

  // ============ File Cache ============
  [IpcChannel.FileCache_Stats]: {
    args: [];
    result: {
      hits: number;
      misses: number;
      hitRate: number;
      memoryUsage: number;
      entryCount: number;
      maxMemory: number;
    };
  };
  [IpcChannel.FileCache_Clear]: {
    args: [];
    result: { success: boolean };
  };
  [IpcChannel.FileCache_Warmup]: {
    args: [filePaths: string[]];
    result: { success: boolean; cachedCount: number };
  };
  [IpcChannel.FileCache_Invalidate]: {
    args: [filePath: string];
    result: { success: boolean };
  };
}
