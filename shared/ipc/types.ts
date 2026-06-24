/**
 * @file IPC Type Definitions
 * @description Type-safe IPC communication types for main/renderer processes
 * @depends types/provider, types/chat
 *
 * Naming conventions:
 * - *DTO suffix for Data Transfer Objects
 * - Dates use ISO 8601 string format (e.g., "2024-01-10T12:00:00.000Z")
 */

// ====== Base Types ======

/**
 * 主进程在「LLM 尚未配置」时,从 agent IPC(startProject → init)抛出的错误标记。
 *
 * WHY 用字符串标记而非数值 code:Electron 的 ipcMain.handle 把 throw 的 Error
 * 跨进程序列化时只可靠保留 message,自定义属性(如 .code)会丢失。因此把这个
 * 稳定标记嵌入 message,renderer 用 `message.includes(marker)` 判别 —— Electron
 * 会给 message 加 "Error invoking remote method '…':" 前缀,故必须 includes 而非
 * 全等。两端 import 同一常量,避免魔法字符串漂移。
 *
 * 语义边界:这是「未配置(预期初始态)」,不是运行时错误 —— renderer 据此渲染
 * 引导卡而非红色报错。
 */
export const AGENT_NOT_CONFIGURED_MARKER = 'AGENT_NOT_CONFIGURED';

// ====== File Operations ======

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  /** Whether directory children have been resolved (lazy loading flag) */
  isResolved?: boolean;
}

export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ctime: string;
}

export interface SelectedFile {
  path: string;
  name: string;
  ext: string;
  content: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

// ====== LaTeX Compilation ======

export interface LaTeXCompileOptions {
  engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  outputDir?: string;
  synctex?: boolean;
  mainFile?: string;
  projectPath?: string;
}

export interface LaTeXCompileResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: string;
  synctexPath?: string;
  errors?: LaTeXError[];
  warnings?: LaTeXWarning[];
  log?: string;
}

export interface LaTeXError {
  line?: number;
  column?: number;
  file?: string;
  message: string;
  severity: 'error' | 'fatal';
}

export interface LaTeXWarning {
  line?: number;
  column?: number;
  file?: string;
  message: string;
  type: 'underfull' | 'overfull' | 'citation' | 'reference' | 'other';
}

// ====== SyncTeX ======

export interface SyncTeXForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTeXBackwardResult {
  file: string;
  line: number;
  column: number;
}

// ====== Overleaf ======

export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
}

export interface OverleafProjectDTO {
  id: string;
  name: string;
  lastUpdated?: string;
  accessLevel?: string;
}

export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

// ====== AI Provider Configuration ======

import type { ModelInfo, ModelSelection, ProviderId, SelectedModels } from '../types/provider';

export interface AIProviderDTO {
  id: ProviderId;
  name: string;
  apiKey: string;
  apiHost: string;
  defaultApiHost?: string;
  enabled: boolean;
  isSystem?: boolean;
  models: ModelInfo[];
  website?: string;
  anthropicApiHost?: string;
  timeout?: number;
  rateLimit?: number;
}

export interface AIConfigDTO {
  providers: AIProviderDTO[];
  selectedModels: SelectedModels;
}

export type { ModelInfo, ModelSelection, ProviderId, SelectedModels };

// All IPC type definitions now live in IPCApiContract in api-types.ts.

// ====== Selection Assistant Types ======

export type SelectionTriggerMode = 'shortcut' | 'hook';

export interface SelectionCaptureDTO {
  text: string;
  sourceApp?: string;
  capturedAt: string;
  cursorPosition?: { x: number; y: number };
}

export interface SelectionConfigDTO {
  enabled: boolean;
  triggerMode: SelectionTriggerMode;
  shortcutKey: string;
}
