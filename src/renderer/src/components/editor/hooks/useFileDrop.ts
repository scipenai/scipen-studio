/* eslint-disable react/exhaustive-deps -- editor refs are read imperatively at drop time. */

/**
 * @file useFileDrop.ts - File Drag & Drop Hook
 * @description Handles image file drag-and-drop into the editor (copy to project + insert LaTeX command)
 */

import type * as monaco from 'monaco-editor';
import type React from 'react';
import { useCallback } from 'react';
import { api } from '../../../api';
import { t } from '../../../locales';
import { createLogger } from '../../../services/LogService';
import { getFileExplorerService } from '../../../services/core/FileExplorerService';
import { getProjectService, getUIService } from '../../../services/core/ServiceRegistry';
import { triggerOverleafNewFileSync } from '../../../utils/overleaf-sync-helper';

const logger = createLogger('useFileDrop');

export interface UseFileDropParams {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
}

export interface UseFileDropReturn {
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => Promise<void>;
}

export function useFileDrop({ editorRef }: UseFileDropParams): UseFileDropReturn {
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // eslint-disable-next-line react/exhaustive-deps -- reads editorRef.current intentionally at drop time
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const editor = editorRef.current;
    if (!editor) return;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const projectService = getProjectService();
    const uiService = getUIService();
    const projectPath = projectService.projectPath;

    if (!projectPath) {
      uiService.addCompilationLog({ type: 'warning', message: t('fileDrop.openProjectFirst') });
      return;
    }

    const fileExplorerService = getFileExplorerService();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.eps', '.svg'];
    const insertTexts: string[] = [];
    let copiedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = file.name;
      const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
      // React's DragEvent.File.path is non-standard; Electron's renderer populates it reliably.
      const srcPath = (file as unknown as { path?: string }).path;

      if (imageExtensions.includes(ext)) {
        if (srcPath) {
          try {
            const destPath = `${projectPath}/${fileName}`.replace(/\\/g, '/');
            const exists = await api.file.exists(destPath);
            if (!exists) {
              await api.file.copy(srcPath, destPath);
              void triggerOverleafNewFileSync(destPath);
              copiedCount++;
            }
          } catch (error) {
            logger.error('Failed to copy image', error);
          }
        }

        const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
        const latexCmd = `\\includegraphics[width=0.8\\textwidth]{${baseName}}`;
        insertTexts.push(latexCmd);
      }
    }

    if (insertTexts.length > 0) {
      const position = editor.getPosition();
      if (position) {
        const text = insertTexts.join('\n');
        editor.executeEdits('smart-drop', [
          {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
            text: text,
          },
        ]);

        if (copiedCount > 0) {
          fileExplorerService.refreshFileTree(projectPath).then((fileTree) => {
            if (fileTree) {
              projectService.setProject(projectPath, fileTree);
            }
          });
        }

        uiService.addCompilationLog({
          type: 'success',
          message:
            copiedCount > 0
              ? t('fileDrop.insertedImagesWithCopy', {
                  count: String(insertTexts.length),
                  copied: String(copiedCount),
                })
              : t('fileDrop.insertedImages', { count: String(insertTexts.length) }),
        });
      }
    }
  }, []);

  return { handleDragOver, handleDrop };
}
