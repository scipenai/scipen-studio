/**
 * @file IPC Handlers Entry
 * @description Exports all IPC handler registration functions for main process
 * @depends fileHandlers, aiHandlers, compileHandlers, etc.
 */

export { registerFileHandlers, type FileHandlersDeps } from './fileHandlers';
export { registerAIHandlers, type AIHandlersDeps } from './aiHandlers';
export { registerCompileHandlers, type CompileHandlersDeps } from './compileHandlers';
export { registerWindowHandlers, type WindowHandlersDeps } from './windowHandlers';
export { registerChatHandlers, type ChatHandlersDeps } from './chatHandlers';
export { registerLSPHandlers, type LSPHandlersDeps } from './lspHandlers';
export { registerConfigHandlers } from './configHandlers';
export { registerDialogHandlers } from './dialogHandlers';
export { registerSettingsHandlers } from './settingsHandlers';
export { registerSelectionHandlers, type SelectionHandlersDeps } from './selectionHandlers';
export { registerIMHandlers } from './imHandlers';
export { registerOverleafHandlers, type OverleafHandlersDeps } from './overleafHandlers';

export { registerCollaborationOwnerHandlers } from './collaborationOwnerHandlers';
export { registerOTHandlers } from './otHandlers';
export { registerOverleafLiveHandlers } from './overleafLiveHandlers';
export { registerProjectBindingHandlers } from './projectBindingHandlers';
export { registerProjectConversationHandlers } from './projectConversationHandlers';
export { registerUpdateHandlers, type UpdateHandlersDeps } from './updateHandlers';

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
