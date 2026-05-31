/* eslint-disable react/exhaustive-deps -- Monaco/editor refs are intentionally consumed imperatively during compile flows. */

/**
 * @file useCompilation.ts - Compilation Hook
 * @description handleCompile + handleCompileResult logic
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useCallback } from 'react';
import { api } from '../../../api';
import { t } from '../../../locales';
import { createLogger } from '../../../services/LogService';
import {
  type CompileOptions,
  type CompileResult,
  getCompileService,
} from '../../../services/core/CompileService';
import { getSettingsService, getUIService } from '../../../services/core/ServiceRegistry';
import type { EditorTab } from '../../../types/app';
import { compilationEntriesToMarkers } from '../utils/editorModelHelpers';

const logger = createLogger('useCompilation');

export interface UseCompilationParams {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  monacoRef: React.RefObject<Monaco | null>;
  activeTab: EditorTab | undefined;
  activeTabPath: string | null;
  isCompiling: boolean;
  compilerEngine: string;
}

export interface UseCompilationReturn {
  handleCompile: () => Promise<void>;
}

export function useCompilation({
  editorRef,
  monacoRef,
  activeTab,
  activeTabPath,
  isCompiling,
  compilerEngine,
}: UseCompilationParams): UseCompilationReturn {
  /** Handles compile result: updates PDF display and UI state */
  // eslint-disable-next-line react/exhaustive-deps -- Monaco/editor refs are read imperatively when compile completes
  const handleCompileResult = useCallback(
    async (result: CompileResult, uiService: ReturnType<typeof getUIService>, filePath: string) => {
      if (result.success) {
        uiService.setEditorVisible(true);
        uiService.setRightPanelTab('preview');
        uiService.setPreviewVisible(true);

        if (result.pdfPath) {
          try {
            const pdfBuffer = await api.file.readBinary(result.pdfPath);
            uiService.updateFilePdfPreview(filePath, {
              pdfPath: result.pdfPath,
              pdfData: pdfBuffer,
              isStale: false,
            });
            uiService.setPdfPath(result.pdfPath);
            uiService.setPdfData(pdfBuffer);
            uiService.setPdfUrl(null);
            uiService.addCompilationLog({ type: 'info', message: `PDF path: ${result.pdfPath}` });
          } catch (readError) {
            console.error('Cannot read PDF file:', readError);
            uiService.addCompilationLog({
              type: 'error',
              message: `Cannot read PDF: ${readError}`,
            });
          }
        } else if (result.pdfBuffer) {
          try {
            const buffer =
              result.pdfBuffer instanceof ArrayBuffer
                ? result.pdfBuffer
                : (result.pdfBuffer.buffer.slice(
                    result.pdfBuffer.byteOffset,
                    result.pdfBuffer.byteOffset + result.pdfBuffer.byteLength
                  ) as ArrayBuffer);
            uiService.updateFilePdfPreview(filePath, {
              pdfPath: result.pdfPath ?? null,
              pdfData: buffer,
              isStale: false,
            });
            uiService.setPdfPath(result.pdfPath ?? null);
            uiService.setPdfData(buffer);
            uiService.setPdfUrl(null);
            uiService.addCompilationLog({
              type: 'info',
              message: `PDF size: ${(buffer.byteLength / 1024).toFixed(1)} KB`,
            });
          } catch (e) {
            logger.error('PDF data processing failed', e);
          }
        } else if (result.pdfData) {
          try {
            const binaryString = atob(result.pdfData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const pdfBuffer = bytes.buffer.slice(0);
            uiService.updateFilePdfPreview(filePath, {
              pdfPath: result.pdfPath ?? null,
              pdfData: pdfBuffer,
              isStale: false,
            });
            uiService.setPdfPath(result.pdfPath ?? null);
            uiService.setPdfData(pdfBuffer);
            uiService.setPdfUrl(null);
            uiService.addCompilationLog({
              type: 'info',
              message: `PDF size: ${(bytes.length / 1024).toFixed(1)} KB (Base64)`,
            });
          } catch (e) {
            logger.error('PDF Base64 decode failed', e);
          }
        }

        if (result.synctexPath) {
          uiService.setSynctexPath(result.synctexPath);
        }
        if (result.buildId) {
          uiService.setRemoteBuildId(result.buildId);
        }
      }

      uiService.setCompilationResult({
        success: result.success,
        pdfPath: result.pdfPath,
        synctexPath: result.synctexPath,
        log: result.log,
        time: result.time,
        errors: result.errors,
        parsedErrors: result.parsedErrors,
        parsedWarnings: result.parsedWarnings,
        parsedInfo: result.parsedInfo,
      });

      const monacoInstance = monacoRef.current;
      const model = editorRef.current?.getModel();
      if (monacoInstance && model) {
        const markers = result.success
          ? []
          : compilationEntriesToMarkers(result.parsedErrors ?? [], filePath, monacoInstance);
        monacoInstance.editor.setModelMarkers(model, 'syntax-worker', []);
        monacoInstance.editor.setModelMarkers(model, 'typst-syntax-worker', []);
        monacoInstance.editor.setModelMarkers(model, 'compile', markers);
      }
    },
    []
  );

  // eslint-disable-next-line react/exhaustive-deps -- reads editorRef.current intentionally at compile time
  const handleCompile = useCallback(async () => {
    const uiService = getUIService();

    if (isCompiling) {
      try {
        // Cancel both the renderer-side WASM compile and the main-process native compile
        getCompileService().cancel();
        const type = activeTab?.name.endsWith('.typ') ? 'typst' : 'latex';
        const result = await api.compile.cancel(type);
        uiService.addCompilationLog({
          type: 'warning',
          message: t('editor.cancelRequested', { status: String(result.cancelled) }),
        });
      } catch (error) {
        uiService.addCompilationLog({
          type: 'error',
          message: t('editor.cancelFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      return;
    }

    if (!activeTab || !activeTabPath) return;

    const settingsService = getSettingsService();
    const compileService = getCompileService();

    uiService.setCompiling(true);
    // Open the preview pane immediately rather than waiting for the compile to finish
    uiService.setEditorVisible(true);
    uiService.setRightPanelTab('preview');
    uiService.setPreviewVisible(true);

    try {
      // Read live content from the Monaco model (not the React-state snapshot on activeTab.content)
      // so that programmatic edits still reach the compiler.
      const liveContent = editorRef.current?.getModel()?.getValue() ?? activeTab.content;

      const options: CompileOptions = {
        engine: compilerEngine as CompileOptions['engine'],
        mainFile: activeTabPath,
        activeTab: activeTab,
      };

      if (activeTab.name.endsWith('.typ')) {
        options.engine = settingsService.compiler.typstEngine || 'tinymist';
      }

      const result = await compileService.compile(activeTabPath, liveContent, options);

      await handleCompileResult(result, uiService, activeTabPath);
    } finally {
      uiService.setCompiling(false);
    }
  }, [isCompiling, activeTab, activeTabPath, compilerEngine, handleCompileResult]);

  return { handleCompile };
}
