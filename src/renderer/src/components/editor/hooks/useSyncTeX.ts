/* eslint-disable react/exhaustive-deps -- editor refs are read imperatively at sync time. */

/**
 * @file useSyncTeX.ts - SyncTeX Jump Hook
 * @description Unified SyncTeX forward/reverse sync logic + outline navigation
 */

import type * as monaco from 'monaco-editor';
import { useCallback } from 'react';
import { api } from '../../../api';
import { useDelayer, useWindowEvent } from '../../../hooks';
import { t } from '../../../locales';
import { createLogger } from '../../../services/LogService';
import { getEditorService, getUIService } from '../../../services/core/ServiceRegistry';
import { getLanguageForFile } from '../../../utils';

const logger = createLogger('useSyncTeX');

export interface UseSyncTeXParams {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  activeTabPath: string | null;
}

export interface UseSyncTeXReturn {
  handleSyncTexJump: () => void;
}

export function useSyncTeX({ editorRef, activeTabPath }: UseSyncTeXParams): UseSyncTeXReturn {
  // ====== Reverse SyncTeX (PDF -> Editor) ======

  useWindowEvent(
    'synctex-goto-line' as keyof WindowEventMap,
    ((event: CustomEvent<{ file: string; line: number; column: number }>) => {
      const { file, line, column } = event.detail;
      const editor = editorRef.current;
      const editorService = getEditorService();

      const normalizePathForCompare = (p: string | null): string => {
        if (!p) return '';
        return p
          .replace(/\\/g, '/')
          .replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`);
      };

      const targetPath = normalizePathForCompare(file);
      const activePath = normalizePathForCompare(activeTabPath);

      const jumpInEditor = () => {
        const currentEditor = editorRef.current;
        if (!currentEditor) return;
        currentEditor.revealLineInCenter(line);
        currentEditor.setPosition({ lineNumber: line, column: column || 1 });
        currentEditor.focus();
      };

      if (editor && activePath === targetPath) {
        jumpInEditor();
        return;
      }

      api.file
        .read(file)
        .then((result) => {
          if (!result?.content) return;
          const fileName = file.split(/[\\/]/).pop() || 'untitled';
          editorService.addTab({
            path: file,
            name: fileName,
            content: result.content,
            isDirty: false,
            language: getLanguageForFile(fileName),
          });
          editorService.setActiveTab(file);
          setTimeout(jumpInEditor, 0);
        })
        .catch((error) => {
          logger.warn('SyncTeX jump failed to open file:', error);
        });
    }) as EventListener
  );

  // ====== Outline Navigate ======

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

  // ====== Forward SyncTeX (Editor -> PDF) ======

  const syncTexDelayer = useDelayer<void>(300);

  // eslint-disable-next-line react/exhaustive-deps -- reads editorRef.current intentionally at call time
  const handleSyncTexJump = useCallback(() => {
    syncTexDelayer.trigger(() => {
      const editor = editorRef.current;
      if (!editor) return;

      const position = editor.getPosition();
      const uiService = getUIService();

      if (!position || (!uiService.pdfData && !uiService.pdfPath)) return;

      const synctexPath = uiService.synctexPath;
      const editorService = getEditorService();
      const currentPath = editorService.activeTabPath;

      if (!currentPath || !synctexPath) {
        uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
        return;
      }

      api.synctex
        .forward(currentPath, position.lineNumber, position.column, synctexPath)
        .then((result) => {
          if (result && result.page !== undefined) {
            uiService.setPdfHighlight({
              page: result.page,
              x: result.x || 0,
              y: result.y || 0,
              width: result.width || 50,
              height: result.height || 20,
            });
            uiService.addCompilationLog({
              type: 'info',
              message: t('syncTeX.jumpToPage', { page: String(result.page) }),
            });
          } else {
            uiService.addCompilationLog({
              type: 'warning',
              message: t('syncTeX.positionNotFound'),
            });
          }
        });
    });
  }, [syncTexDelayer]);

  return { handleSyncTexJump };
}
