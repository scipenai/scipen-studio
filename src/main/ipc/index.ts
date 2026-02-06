/**
 * @file IPC Handlers Entry
 * @description Exports all IPC handler registration functions for main process
 * @depends fileHandlers, aiHandlers, agentHandlers, compileHandlers, knowledgeHandlers, etc.
 */

export { registerFileHandlers, type FileHandlersDeps } from './fileHandlers';
export { registerAIHandlers, type AIHandlersDeps } from './aiHandlers';
export { registerAgentHandlers, type AgentHandlersDeps } from './agentHandlers';
export { registerCompileHandlers, type CompileHandlersDeps } from './compileHandlers';
export {
  registerKnowledgeHandlers,
  setupKnowledgeEventForwarding,
  type KnowledgeHandlersDeps,
} from './knowledgeHandlers';
export { registerOverleafHandlers, type OverleafHandlersDeps } from './overleafHandlers';
export { registerWindowHandlers, type WindowHandlersDeps } from './windowHandlers';
export { registerChatHandlers, type ChatHandlersDeps } from './chatHandlers';
export { registerLSPHandlers, type LSPHandlersDeps } from './lspHandlers';
export { registerConfigHandlers } from './configHandlers';
export { registerDialogHandlers } from './dialogHandlers';
export { registerSettingsHandlers } from './settingsHandlers';
export { registerSelectionHandlers, type SelectionHandlersDeps } from './selectionHandlers';

// ====== Type-Safe IPC Utilities ======
export {
  registerTypedHandler,
  registerHandler,
  createTypedHandlers,
  createHandlerFactory,
  unregisterHandler,
  unregisterHandlers,
  type IPCHandler,
  type IPCHandlerWithoutEvent,
  type HandlersMap,
  type HandlerOptions,
} from './typedIpc';

// ====== Path Helpers (for other modules) ======
export {
  isRemotePath,
  getProjectIdFromPath,
  getRelativePathFromRemote,
  findFolderIdByPath,
} from './fileHandlers';
