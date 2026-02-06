/**
 * @file useFileDrop.ts - File Drop Hook
 * @description Handles image drag-drop to editor, auto-copies and generates LaTeX reference commands
 */

import type * as monaco from 'monaco-editor';
import type { IDisposable } from '../../../../../../shared/utils';
import { api } from '../../../api';
import { t } from '../../../locales';
import { createLogger } from '../../../services/LogService';
import { getProjectService, getUIService } from '../../../services/core';

const logger = createLogger('useFileDrop');

interface UseFileDropOptions {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
}

/**
 * Setup drag-and-drop handling for the editor
 * Called in handleEditorMount
 *
 * @returns IDisposable - Used to clean up event listeners to prevent memory leaks
 */
export function setupFileDrop(editor: monaco.editor.IStandaloneCodeEditor): IDisposable {
  const editorDomNode = editor.getDomNode();
  if (!editorDomNode) {
    return { dispose: () => {} };
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const projectService = getProjectService();
    const uiService = getUIService();
    const projectPath = projectService.projectPath;

    // Check if this is a remote project (Overleaf)
    const isRemote = projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');
    if (isRemote) {
      uiService.addCompilationLog({ type: 'warning', message: t('fileDrop.remoteNotSupported') });
      return;
    }

    if (!projectPath) {
      uiService.addCompilationLog({ type: 'warning', message: t('fileDrop.openProjectFirst') });
      return;
    }

    await handleFileDrop(editor, files, projectPath, uiService);
  };

  // Add event listeners
  editorDomNode.addEventListener('dragover', handleDragOver);
  editorDomNode.addEventListener('drop', handleDrop);

  // Return IDisposable to clean up event listeners
  return {
    dispose: () => {
      editorDomNode.removeEventListener('dragover', handleDragOver);
      editorDomNode.removeEventListener('drop', handleDrop);
    },
  };
}

/**
 * Handle file drop operation
 */
async function handleFileDrop(
  editor: monaco.editor.IStandaloneCodeEditor,
  files: FileList,
  projectPath: string,
  uiService: ReturnType<typeof getUIService>
): Promise<void> {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.eps', '.svg'];
  const insertTexts: string[] = [];
  let copiedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileName = file.name;
    const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    // Electron extends the File object with a path property
    const srcPath = (file as File & { path?: string }).path;

    if (imageExtensions.includes(ext)) {
      // Copy file to project directory
      if (srcPath) {
        try {
          const destPath = `${projectPath}/${fileName}`.replace(/\\/g, '/');

          // Check if file already exists
          const exists = await api.file.exists(destPath);
          if (!exists) {
            await api.file.copy(srcPath, destPath);
            copiedCount++;
          }
        } catch (error) {
          logger.error(t('fileDrop.copyImageFailed'), error);
        }
      }

      // Generate relative path (remove extension, LaTeX will auto-detect)
      const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
      // Generate \includegraphics command
      const latexCmd = `\\includegraphics[width=0.8\\textwidth]{${baseName}}`;
      insertTexts.push(latexCmd);
    }
  }

  if (insertTexts.length > 0) {
    insertTextAtCursor(editor, insertTexts, copiedCount, projectPath, uiService);
  }
}

/**
 * Insert text at cursor position
 */
function insertTextAtCursor(
  editor: monaco.editor.IStandaloneCodeEditor,
  insertTexts: string[],
  copiedCount: number,
  projectPath: string,
  uiService: ReturnType<typeof getUIService>
): void {
  const position = editor.getPosition();
  if (!position) return;

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
    api.file.refreshTree(projectPath).then((result) => {
      if (result?.success && result.fileTree) {
        getProjectService().setProject(projectPath, result.fileTree);
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

/**
 * useFileDrop Hook (optional, for component-level drag-and-drop state management)
 */
export function useFileDrop(_options: UseFileDropOptions): void {
  // Currently, drag-and-drop logic is set up via setupFileDrop in handleEditorMount
  // This hook is reserved for future extensions (e.g., drag state indicators)
}
