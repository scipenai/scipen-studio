/**
 * @file IPC Type System - Entry Point
 * @description Unified exports for IPC types, utilities, and clients
 * @depends ipc/channels, ipc/types, ipc/client, api-types
 */

// ====== IPC Channel Enum ======

export { IpcChannel, type IpcChannelType } from './channels';

// ====== Type Definitions ======

export type {
  IPCChannel,
  IPCEventChannel,
  IPCParams,
  IPCResult,
  IPCEventData,
  IPCHandlers,
  IPCEvents,
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
  AgentAvailability,
  AgentResult,
  AgentResultData,
  AgentProgress,
  Pdf2LatexConfig,
  Paper2BeamerConfig,
  KnowledgeBaseInfo,
  MediaType,
  ProcessStatus,
  RetrieverType,
  EmbeddingProvider,
  ChunkingConfig,
  EmbeddingConfig,
  RetrievalConfig,
  KnowledgeLibrary,
  KnowledgeDocument,
  ChunkMetadata,
  KnowledgeSearchResult,
  KnowledgeCitation,
  KnowledgeRAGResponse,
  AdvancedRetrievalConfig,
  RewrittenQuery,
  ContextDecision,
  EnhancedSearchResult,
  KnowledgeInitOptions,
  KnowledgeTaskStatus,
  KnowledgeQueueStats,
  KnowledgeDiagnostics,
  KnowledgeEvent,
  OverleafConfig,
  OverleafProject,
  OverleafCompileOptions,
  OverleafCompileResult,
  ParsedLogEntry,
} from './types';

// ====== Client Utilities ======

export {
  ipc,
  onIPCEvent,
  isValidChannel,
  type AllIPCChannels,
  type IPCHandler,
  type IPCEventListener,
} from './client';

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
  KnowledgeInitOptions as KnowledgeInitConfig,
  KnowledgeSearchOptions,
  KnowledgeEnhancedSearchOptions,
  OverleafConfig as OverleafInitConfig,
  OverleafCompileOptions as OverleafCompileParams,
  WindowInfo,
  LogEntry,
  ConfirmDialogOptions,
  MessageDialogOptions,
} from '../api-types';
