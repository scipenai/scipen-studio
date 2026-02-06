/**
 * @file useService.ts - Service access Hooks
 * @description Provides declarative React Hooks for accessing various services in components
 * @depends ServiceRegistry
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  type IServiceRegistry,
  getAIService,
  getBackupService,
  getCommandService,
  getCompileService,
  getEditorService,
  getKeybindingService,
  getProjectService,
  getServices,
  getSettingsService,
  getStorageService,
  getUIService,
  getViewRegistry,
  getWorkingCopyService,
} from '../services/core/ServiceRegistry';

// ============ useServiceRegistry ============

/**
 * React Hook: useServiceRegistry
 *
 * Get the service registry. Use this when you need access to multiple services.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const services = useServiceRegistry();
 *
 *   const handleSave = () => {
 *     services.editor.saveActiveFile();
 *   };
 *
 *   return <button onClick={handleSave}>Save</button>;
 * }
 * ```
 */
export function useServiceRegistry(): IServiceRegistry {
  return useMemo(() => getServices(), []);
}

// ============ Individual Service Hooks ============

/**
 * React Hook: useEditorService
 */
export function useEditorService() {
  return useMemo(() => getEditorService(), []);
}

/**
 * React Hook: useAIService
 */
export function useAIService() {
  return useMemo(() => getAIService(), []);
}

/**
 * React Hook: useProjectService
 */
export function useProjectService() {
  return useMemo(() => getProjectService(), []);
}

/**
 * React Hook: useUIService
 */
export function useUIService() {
  return useMemo(() => getUIService(), []);
}

/**
 * React Hook: useSettingsService
 */
export function useSettingsService() {
  return useMemo(() => getSettingsService(), []);
}

/**
 * React Hook: useWorkingCopyService
 */
export function useWorkingCopyService() {
  return useMemo(() => getWorkingCopyService(), []);
}

/**
 * React Hook: useBackupService
 */
export function useBackupService() {
  return useMemo(() => getBackupService(), []);
}

/**
 * React Hook: useCompileService
 */
export function useCompileService() {
  return useMemo(() => getCompileService(), []);
}

/**
 * React Hook: useCommandService
 */
export function useCommandService() {
  return useMemo(() => getCommandService(), []);
}

/**
 * React Hook: useKeybindingService
 */
export function useKeybindingService() {
  return useMemo(() => getKeybindingService(), []);
}

/**
 * React Hook: useViewRegistry
 */
export function useViewRegistry() {
  return useMemo(() => getViewRegistry(), []);
}

/**
 * React Hook: useStorageService
 */
export function useStorageService() {
  return useMemo(() => getStorageService(), []);
}

// ============ Service State Hooks ============

/**
 * React Hook: useServiceState
 *
 * Subscribe to a service's state and re-render when it changes.
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 *
 * @example
 * ```tsx
 * function EditorStatus() {
 *   const editorService = useEditorService();
 *
 *   const activeTab = useServiceState(
 *     editorService.onDidChangeActiveTab,
 *     () => editorService.activeTab
 *   );
 *
 *   return <span>{activeTab?.name ?? 'No file'}</span>;
 * }
 * ```
 */
export function useServiceState<T>(
  subscribe: (callback: () => void) => { dispose: () => void },
  getSnapshot: () => T
): T {
  const subscribeWithCleanup = useCallback(
    (callback: () => void) => {
      const disposable = subscribe(callback);
      return () => disposable.dispose();
    },
    [subscribe]
  );

  return useSyncExternalStore(subscribeWithCleanup, getSnapshot, getSnapshot);
}
