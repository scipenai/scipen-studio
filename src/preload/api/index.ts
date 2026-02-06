/**
 * @file Preload API Entry
 * @description Exports all domain API modules for use in main preload script
 * @depends api modules (file, ai, agent, knowledge, lsp, overleaf, chat, window, system, settings, selection, localReplica, _shared)
 */

export { fileApi, fileWatcherApi } from './file';
export { aiApi } from './ai';
export { agentApi } from './agent';
export { knowledgeApi } from './knowledge';
export { lspApi } from './lsp';
export { overleafApi } from './overleaf';
export { chatApi } from './chat';
export { windowApi, dialogApi } from './window';
export { projectApi, compileApi, appApi, logApi, configApi, traceApi } from './system';
export { settingsApi } from './settings';
export { selectionApi } from './selection';
export { localReplicaApi } from './localReplica';

// Re-export shared utilities for the main preload script
export {
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  isPathSafe,
  createSafeListener,
  createSafeVoidListener,
} from './_shared';
