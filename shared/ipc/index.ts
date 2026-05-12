/**
 * @file IPC Type System - Entry Point
 * @description Unified exports for IPC types, utilities, and clients
 * @depends ipc/channels, ipc/types, ipc/client, api-types
 */

// ====== IPC Channel Enum ======

export { IpcChannel, type IpcChannelType } from './channels';

// ====== Shared Data Types (from types.ts) ======

export type {
  FileTreeNode,
  FileStats,
  SelectedFile,
  FileFilter,
  LaTeXCompileOptions,
  LaTeXCompileResult,
  LaTeXError,
  LaTeXWarning,
  SyncTeXForwardResult,
  SyncTeXBackwardResult,
  OverleafConfig,
  OverleafProjectDTO,
  ParsedLogEntry,
  AIProviderDTO,
  AIConfigDTO,
  SelectionTriggerMode,
  SelectionCaptureDTO,
  SelectionConfigDTO,
} from './types';

// ====== API Type Contract ======

export type {
  IPCApiContract,
  IPCArgs,
  IPCResult as IPCApiResult,
  IPCInvokeChannel,
  IPCEventContract,
  IPCEventChannel as IPCApiEventChannel,
  IPCEventData as IPCApiEventData,
  TypstCompileOptions,
  TypstCompileResult,
  TypstAvailability,
  BatchReadResult,
  BatchStatResult,
  BatchExistsResult,
  BatchWriteResult,
  AIConfig,
  AIResult,
  AITestResult,
  AIChatMessage,
  LSPProcessInfo,
  LSPStartOptions,
  LSPDiagnostic,
  LSPCompletionItem,
  LSPHover,
  LSPLocation,
  LSPDocumentSymbol,
  LSPTextChange,
  OverleafConfig as OverleafInitConfig,
  WindowInfo,
  LogEntry,
  ConfirmDialogOptions,
  MessageDialogOptions,
} from '../api-types';
