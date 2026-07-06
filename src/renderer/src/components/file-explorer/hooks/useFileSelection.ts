/**
 * @file useFileSelection.ts - File selection and lazy-loading hook
 * @description Handles opening files in the editor and on-demand directory resolution.
 */

import { useCallback } from 'react';
import type { FileNode } from '../../../types';
import { api } from '../../../api';
import { getEditorService, getUIService } from '../../../services/core';
import { getLanguageForFile } from '../../../utils';
import { updateFileIndex } from '../../../services/InlineCompletionService';

interface UseFileSelectionOptions {
  projectPath: string | null;
  setSelectedNode: (node: FileNode | null) => void;
}

export function useFileSelection({ projectPath, setSelectedNode }: UseFileSelectionOptions) {
  const editorService = getEditorService();
  const uiService = getUIService();

  const handleFileSelect = useCallback(
    async (node: FileNode) => {
      setSelectedNode(node);

      if (node.type !== 'file') return;

      const normalizedPath = node.path.replace(/\\/g, '/');
      const ext = node.name.split('.').pop()?.toLowerCase() ?? '';

      // PDF files: route to the preview panel, not the text editor.
      // Also try to open the corresponding source file (.tex/.typ).
      if (ext === 'pdf') {
        await handlePdfSelect(normalizedPath, node);
        uiService.setSidebarTab('im');
        return;
      }

      if (node.isFileRef) {
        uiService.addCompilationLog({
          type: 'info',
          message: `${node.name} is a binary file and cannot be opened in editor`,
        });
        return;
      }

      const existingTab = editorService.getTab(normalizedPath);
      if (existingTab) {
        editorService.setActiveTab(normalizedPath);
        uiService.setResearchLayoutFocus('balanced');
        uiService.setEditorVisible(true);
        uiService.setSidebarTab('im');
        return;
      }

      console.info('[FileExplorer] handleFileSelect:', {
        originalPath: node.path,
        normalizedPath,
        name: node.name,
        _id: node._id,
      });

      try {
        if (!api.file.read) {
          throw new Error('Electron API not available, ensure running in Electron environment');
        }
        console.info('[FileExplorer] Reading local file:', normalizedPath);
        const result = await api.file.read(normalizedPath);
        const content = result.content;
        if (content === null) {
          throw new Error(`File content is unavailable: ${normalizedPath}`);
        }
        console.info('[FileExplorer] File content read success:', {
          path: normalizedPath,
          contentLength: content.length,
          mtime: result.mtime,
        });
        editorService.updateFileMtime(normalizedPath, result.mtime);

        const language = getLanguageForFile(node.name);

        if (ext === 'bib' || ext === 'tex' || ext === 'typ') {
          updateFileIndex(normalizedPath, content);
        }

        console.info('[FileExplorer] Calling addTab:', {
          path: normalizedPath,
          name: node.name,
          language,
        });
        editorService.addTab({
          path: normalizedPath,
          name: node.name,
          content,
          isDirty: false,
          language,
          _id: node._id,
          projectId: node.projectId,
        });

        uiService.setResearchLayoutFocus('balanced');
        uiService.setEditorVisible(true);
        uiService.setSidebarTab('im');
      } catch (error) {
        console.error('[FileExplorer] Failed to read file:', error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Cannot read file: ${node.name} - ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    },
    [editorService, uiService, setSelectedNode]
  );

  const handleResolveChildren = useCallback(
    async (dirPath: string) => {
      if (!projectPath) return;
      const projectService = (await import('../../../services/core')).getProjectService();

      try {
        const result = await api.file.resolveChildren(dirPath);
        if (result.success && result.children) {
          projectService.updateNodeChildren(dirPath, result.children);
        }
      } catch (error) {
        console.error('Failed to resolve children:', error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Failed to load directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    },
    [projectPath, uiService]
  );

  return {
    handleFileSelect,
    handleResolveChildren,
  };
}

/**
 * Handle clicking a PDF file in the file explorer.
 *
 * Instead of opening the binary PDF in the text editor (which would produce
 * garbled content), this routes the PDF to the preview panel and opens the
 * corresponding source file (.tex / .typ) in the editor so the user can
 * continue editing with the preview visible.
 *
 * If no source file is found, the PDF is still loaded into the preview.
 */
async function handlePdfSelect(pdfPath: string, node: FileNode): Promise<void> {
  const editorService = getEditorService();
  const uiService = getUIService();

  const dir = pdfPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const baseName = node.name.replace(/\.pdf$/i, '');

  const sourceExts = ['.tex', '.typ', '.latex', '.ltx'];
  let sourcePath: string | null = null;
  for (const srcExt of sourceExts) {
    const candidate = `${dir}/${baseName}${srcExt}`;
    try {
      if (await api.file.exists(candidate)) {
        sourcePath = candidate;
        break;
      }
    } catch {
      // continue to next extension
    }
  }

  if (sourcePath) {
    const existingTab = editorService.getTab(sourcePath);
    if (existingTab) {
      editorService.setActiveTab(sourcePath);
    } else {
      try {
        const result = await api.file.read(sourcePath);
        const srcName = sourcePath.split(/[/\\]/).pop() || baseName;
        editorService.updateFileMtime(sourcePath, result.mtime);
        editorService.addTab({
          path: sourcePath,
          name: srcName,
          content: result.content ?? '',
          isDirty: false,
          language: getLanguageForFile(srcName),
          _id: node._id,
          projectId: node.projectId,
        });
      } catch (error) {
        console.error('[FileExplorer] Failed to open source file for PDF:', error);
      }
    }
    uiService.setResearchLayoutFocus('balanced');
    uiService.setEditorVisible(true);
    uiService.setPreviewVisible(true);
    uiService.setRightPanelTab('preview');
    // syncPdfPreviewForFile (triggered by tab change) will load the PDF from disk
  } else {
    // No source file — load the PDF directly into the preview
    try {
      const pdfData = await api.file.readBinary(pdfPath);
      uiService.updateFilePdfPreview(pdfPath, { pdfPath, pdfData, isStale: false });
      uiService.setPreviewMode('pdf');
      uiService.setPdfPath(pdfPath);
      uiService.setPdfData(pdfData);
      uiService.setPreviewVisible(true);
      uiService.setRightPanelTab('preview');

      const synctexPath = pdfPath.replace(/\.pdf$/i, '.synctex.gz');
      if (await api.file.exists(synctexPath)) {
        uiService.setSynctexPath(synctexPath);
        uiService.setSynctexProjectRoot(null);
      }
    } catch (error) {
      console.error('[FileExplorer] Failed to load PDF:', error);
      uiService.addCompilationLog({
        type: 'error',
        message: `Cannot load PDF: ${node.name} - ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }
}
