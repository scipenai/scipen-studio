/**
 * @file index.ts - Editor Hooks Export
 * @description Unified export entry for editor-related custom hooks
 */

export { useFileDrop } from './useFileDrop';
export { useEditorEvents } from './useEditorEvents';

// Editor setup functions (not hooks)
export {
  setupCursorTracking,
  setupScrollTracking,
  setupContentChangeTracking,
  setupSyncTexClick,
  setupShortcuts,
  initializeLSPDocument,
} from './editorSetup';
