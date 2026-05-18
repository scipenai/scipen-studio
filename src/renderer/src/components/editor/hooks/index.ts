/**
 * @file index.ts - Editor Hooks Export
 * @description Unified export entry for editor-related custom hooks
 */

export { useEditorEvents } from './useEditorEvents';
export { useDiffReview } from './useDiffReview';
export { useCompilation } from './useCompilation';
export { useSyncTeX } from './useSyncTeX';
export { useDiagnostics } from './useDiagnostics';
export { useFileDrop } from './useFileDrop';

// Editor setup functions (not hooks)
export {
  setupCursorTracking,
  setupScrollTracking,
  setupContentChangeTracking,
  setupSyncTexClick,
  setupShortcuts,
  initializeLSPDocument,
} from './editorSetup';
