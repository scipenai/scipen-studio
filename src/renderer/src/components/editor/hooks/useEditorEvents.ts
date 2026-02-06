/**
 * @file useEditorEvents.ts - Editor Events Hook
 * @description Handles SyncTeX navigation, outline navigation, compile shortcuts and other global events
 */

import type * as monaco from 'monaco-editor';
import { useWindowEvent } from '../../../hooks';

interface UseEditorEventsOptions {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  activeTabPath: string | null;
  onCompile: () => void;
  onPolish: () => void;
}

/**
 * useEditorEvents Hook
 * Manages global event listeners related to the editor
 * Uses useWindowEvent to automatically manage event listener lifecycle
 */
export function useEditorEvents({
  editorRef,
  activeTabPath,
  onCompile,
  onPolish,
}: UseEditorEventsOptions): void {
  // SyncTeX reverse sync event (jump from PDF to source code)
  // Uses useWindowEvent to automatically manage event listeners
  useWindowEvent(
    'synctex-goto-line' as keyof WindowEventMap,
    ((event: CustomEvent<{ file: string; line: number; column: number }>) => {
      const { file, line, column } = event.detail;
      const editor = editorRef.current;
      if (editor && activeTabPath === file) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: column || 1 });
        editor.focus();
      }
    }) as EventListener
  );

  // Outline navigation event
  useWindowEvent(
    'outline-navigate' as keyof WindowEventMap,
    ((event: CustomEvent<{ line: number }>) => {
      const { line } = event.detail;
      const editor = editorRef.current;
      if (editor) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
    }) as EventListener
  );

  // Global compile shortcut event
  useWindowEvent(
    'trigger-compile' as keyof WindowEventMap,
    (() => {
      onCompile();
    }) as EventListener
  );

  // Global AI polish shortcut event
  useWindowEvent(
    'trigger-ai-polish' as keyof WindowEventMap,
    (() => {
      onPolish();
    }) as EventListener
  );
}
