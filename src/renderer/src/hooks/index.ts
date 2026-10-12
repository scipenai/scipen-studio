/**
 * @file index.ts - Hooks export entry
 * @description Centralized export of all custom React Hooks
 * @depends All hook modules in this directory
 */

// ============ Async Hooks ============
export { useDelayer, useDebounce } from './useAsync';

// ============ DOM Hooks ============
export {
  useWindowEvent,
  useDocumentEvent,
  useInterval,
  useClickOutside,
  useEscapeKey,
  useRequestAnimationFrame,
} from './useDOM';

// ============ Disposable Hooks ============
export {
  useDisposables,
  useDisposable,
  useMutableDisposable,
} from './useDisposable';

// ============ Event Hooks ============
export { useEvent, useIpcEvent } from './useEvent';

// ============ App-specific Hooks ============
export { useThemeSync } from './useThemeSync';
export { useLocaleSync } from './useLocaleSync';
export { useAIConfigSync } from './useConfigSync';
export { useLSPInit } from './useLSPInit';
export { useFileWatcher } from './useFileWatcher';
export { useGlobalShortcuts } from './useGlobalShortcuts';
export { useMemoryCleanup } from './useMemoryCleanup';
export { useFileOpen } from './useFileOpen';
export { useAgentBridge } from './useAgentBridge';
export { useTextSelectionActive } from './useTextSelectionActive';
export { useZoteroBibMirror, useZoteroMirrorLifecycle } from './useZoteroBibMirror';
export type { UseZoteroBibMirrorResult } from './useZoteroBibMirror';
