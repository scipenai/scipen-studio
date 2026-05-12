/**
 * @file Preload API Entry
 * @description Exports all domain API modules for use in main preload script
 * @depends api modules (file, ai, agent, lsp, chat, window, system, settings, selection, _shared)
 */

export { fileApi, fileWatcherApi } from './file';
export { aiApi } from './ai';
export { lspApi } from './lsp';
export { chatApi } from './chat';
export { windowApi, dialogApi } from './window';
export { projectApi, compileApi, appApi, logApi, configApi, traceApi } from './system';
export { settingsApi } from './settings';
export { selectionApi } from './selection';
export { imApi } from './im';
export { otApi } from './ot';
export { overleafLiveApi } from './overleafLive';
export { projectBindingApi } from './projectBinding';
export { projectConversationApi } from './projectConversation';

// Re-export shared utilities for the main preload script
export {
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  isPathSafe,
  createSafeListener,
  createSafeVoidListener,
} from './_shared';
