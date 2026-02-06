/**
 * @file index.ts - Hooks export entry
 * @description Centralized export of all custom React Hooks
 * @depends All hook modules in this directory
 */

// ============ Async Hooks ============
export {
  useDelayer,
  useThrottler,
  useIdleCallback,
  useDebounce,
} from './useAsync';

// ============ DOM Hooks ============
export {
  useWindowEvent,
  useDocumentEvent,
  useInterval,
  useTimeout,
  useClickOutside,
  useEscapeKey,
  useIntersectionObserver,
  useAnimationFrame,
  useRequestAnimationFrame,
} from './useDOM';

// ============ Disposable Hooks ============
export {
  useDisposables,
  useDisposable,
  useMutableDisposable,
} from './useDisposable';

// ============ Event Hooks ============
export {
  useEvent,
  useEventValue,
  useDebouncedEvent,
  useEventBuffer,
  useEmitter,
  useIpcEvent,
} from './useEvent';

// ============ Service Hooks ============
export {
  useServiceRegistry,
  useEditorService,
  useAIService,
  useProjectService,
  useUIService,
  useSettingsService,
  useWorkingCopyService,
  useBackupService,
  useCompileService,
  useCommandService,
  useKeybindingService,
  useViewRegistry,
  useStorageService,
  useServiceState,
} from './useService';

// ============ App-specific Hooks ============
export { useThemeSync } from './useThemeSync';
export { useLocaleSync } from './useLocaleSync';
export { useKnowledgeConfigSync, useAIConfigSync } from './useConfigSync';
export { useLSPInit } from './useLSPInit';
export { useFileWatcher } from './useFileWatcher';
export { useGlobalShortcuts } from './useGlobalShortcuts';
export { useMemoryCleanup } from './useMemoryCleanup';
export { useOverleafFlushOnUnload } from './useOverleafSync';
export { useFileOpen } from './useFileOpen';

// ============ Chat Hooks ============
export {
  useChatService,
  useChatMessages,
  useChatSessions,
  useCurrentChatSession,
  useChatGenerating,
  type UseChatServiceReturn,
} from './useChatService';
