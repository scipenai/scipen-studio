/* eslint-disable react/exhaustive-deps -- Monaco/editor refs and disposable sinks are intentionally imperative here. */

/**
 * @file useDiagnostics.ts - Diagnostics Hook
 * @description Syntax worker diagnostics + LSP diagnostics + debounced run
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useCallback, useRef } from 'react';
import { useDelayer } from '../../../hooks';
import { type TranslationKey, useTranslation } from '../../../locales';
import { createLogger } from '../../../services/LogService';
import { LSPService } from '../../../services/LSPService';
import type { DisposableStore } from '../../../../../../shared/utils';
import { TaskPriority, scheduleIdleTask } from '../../../services/core/IdleTaskScheduler';
import { getEditorService } from '../../../services/core/ServiceRegistry';
import {
  type SyntaxMarker,
  getSyntaxWorkerClient,
  mapSeverityToMonaco,
} from '../../../workers/SyntaxWorkerClient';

const logger = createLogger('useDiagnostics');

export interface UseDiagnosticsParams {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  monacoRef: React.RefObject<Monaco | null>;
  disposablesRef: React.RefObject<DisposableStore>;
  activeTabPath: string | null;
  activeTabLanguage: string | undefined;
}

export interface UseDiagnosticsReturn {
  runDiagnostics: (
    content: string,
    monacoInstance: Monaco,
    model: monaco.editor.ITextModel | null
  ) => Promise<void>;
  debouncedRunDiagnostics: (value: string) => void;
  setupLSPDiagnostics: (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: Monaco
  ) => void;
}

function convertToMonacoMarkers(
  syntaxMarkers: SyntaxMarker[],
  monacoInstance: Monaco,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
): monaco.editor.IMarkerData[] {
  return syntaxMarkers.map((marker) => ({
    severity: mapSeverityToMonaco(marker.severity, monacoInstance),
    message: t(marker.messageKey as TranslationKey, marker.messageArgs ?? {}),
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  }));
}

export function useDiagnostics({
  editorRef,
  monacoRef,
  disposablesRef,
  activeTabPath,
  activeTabLanguage,
}: UseDiagnosticsParams): UseDiagnosticsReturn {
  const { t } = useTranslation();
  const runDiagnostics = useCallback(
    async (content: string, monacoInstance: Monaco, model: monaco.editor.ITextModel | null) => {
      if (!monacoInstance || !model) return;

      try {
        const syntaxWorker = getSyntaxWorkerClient();
        const syntaxMarkers = await syntaxWorker.runDiagnostics(content);

        if (model.isDisposed()) {
          return;
        }

        const markers = convertToMonacoMarkers(syntaxMarkers, monacoInstance, t);
        const markerOwner = activeTabLanguage === 'typst' ? 'typst-syntax-worker' : 'syntax-worker';
        monacoInstance.editor.setModelMarkers(model, markerOwner, markers);
      } catch (error) {
        console.error('[EditorPane] Syntax check failed:', error);
      }
    },
    [activeTabLanguage, t]
  );

  // Delayer gives us Promise support, cancellation, and cleaner lifecycle than raw setTimeout.
  const diagnosticsDelayer = useDelayer<void>(1000);
  const diagnosticsVersionRef = useRef<number>(0);

  // Version counter discards stale diagnostics that arrive after newer results.
  // eslint-disable-next-line react/exhaustive-deps -- Monaco/editor refs are read imperatively during scheduled execution
  const debouncedRunDiagnostics = useCallback(
    (value: string) => {
      void value;
      const currentVersion = ++diagnosticsVersionRef.current;

      diagnosticsDelayer.trigger(() => {
        if (monacoRef.current && editorRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            scheduleIdleTask(
              () => {
                if (currentVersion !== diagnosticsVersionRef.current) {
                  logger.debug('Diagnostics version outdated, skipping');
                  return;
                }

                const currentTabPath = getEditorService().activeTab?.path;
                if (activeTabPath && currentTabPath && activeTabPath !== currentTabPath) {
                  return;
                }

                if (monacoRef.current && editorRef.current) {
                  const currentModel = editorRef.current.getModel();
                  if (currentModel) {
                    runDiagnostics(currentModel.getValue(), monacoRef.current, currentModel);
                  }
                }
              },
              {
                id: `diagnostics-${activeTabPath}`,
                priority: TaskPriority.High,
                timeout: 3000,
              }
            );
          }
        }
      });
    },
    [diagnosticsDelayer, runDiagnostics, activeTabPath]
  );

  // eslint-disable-next-line react/exhaustive-deps -- disposablesRef is a mutable ref sink, not a reactive dependency
  const setupLSPDiagnostics = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: Monaco): void => {
      const cleanupDiagnostics = LSPService.onDiagnostics((filePath, diagnostics) => {
        const currentModel = editor.getModel();
        if (!currentModel) return;

        const currentPath = currentModel.uri.path;
        if (!currentPath.includes(filePath) && !filePath.includes(currentPath)) return;

        const markers = LSPService.convertDiagnosticsToMarkers(diagnostics, currentModel);
        monacoInstance.editor.setModelMarkers(currentModel, 'texlab', markers);
      });

      disposablesRef.current.add({ dispose: cleanupDiagnostics });
    },
    []
  );

  return {
    runDiagnostics,
    debouncedRunDiagnostics,
    setupLSPDiagnostics,
  };
}
