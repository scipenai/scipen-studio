/**
 * @file useFileSelection.ts - File selection and lazy-loading hook
 * @description Handles opening files in the editor (local, remote, OT) and on-demand directory resolution.
 */

import { useCallback } from 'react';
import type { FileNode } from '../../../types';
import { api } from '../../../api';
import { getEditorService, getOTService, getUIService } from '../../../services/core';
import { updateFileIndex } from '../../../services/InlineCompletionService';

interface UseFileSelectionOptions {
  projectPath: string | null;
  collaborationProjectId: string | null;
  setSelectedNode: (node: FileNode | null) => void;
}

export function useFileSelection({
  projectPath,
  collaborationProjectId,
  setSelectedNode,
}: UseFileSelectionOptions) {
  const editorService = getEditorService();
  const uiService = getUIService();

  const handleFileSelect = useCallback(
    async (node: FileNode) => {
      setSelectedNode(node);

      if (node.type === 'file') {
        if (node.isFileRef) {
          uiService.addCompilationLog({
            type: 'info',
            message: `${node.name} is a binary file and cannot be opened in editor`,
          });
          return;
        }

        const normalizedPath = node.path.replace(/\\/g, '/');
        const existingTab = editorService.getTab(normalizedPath);
        if (existingTab) {
          editorService.setActiveTab(normalizedPath);
          uiService.setResearchLayoutFocus('balanced');
          uiService.setWorkspaceMode('chat-editor');
          return;
        }

        console.info('[FileExplorer] handleFileSelect:', {
          originalPath: node.path,
          normalizedPath,
          name: node.name,
          _id: node._id,
        });

        try {
          let content: string | null = '';
          let docId = node._id;

          if (collaborationProjectId && node._id) {
            const file = await getOTService().getProjectFile(collaborationProjectId, node._id);
            content = file.content;
            docId = file.id;
            node.projectId = collaborationProjectId;
          } else {
            if (api.file.read) {
              console.info('[FileExplorer] Reading local file:', normalizedPath);
              const result = await api.file.read(normalizedPath);
              content = result.content;
              console.info('[FileExplorer] File content read success:', {
                path: normalizedPath,
                contentLength: content?.length || 0,
                mtime: result.mtime,
              });

              editorService.updateFileMtime(normalizedPath, result.mtime);
            } else {
              console.error('[FileExplorer] api.file.read not available');
              throw new Error('Electron API not available, ensure running in Electron environment');
            }
          }

          if (content === null) {
            throw new Error(`Remote file content is unavailable: ${normalizedPath}`);
          }

          const ext = node.name.split('.').pop()?.toLowerCase();
          let language = 'plaintext';
          if (ext === 'tex' || ext === 'latex') language = 'latex';
          else if (ext === 'bib') language = 'bibtex';
          else if (ext === 'md') language = 'markdown';
          else if (ext === 'json') language = 'json';
          else if (ext === 'js' || ext === 'jsx') language = 'javascript';
          else if (ext === 'ts' || ext === 'tsx') language = 'typescript';
          else if (ext === 'sty' || ext === 'cls') language = 'latex';
          else if (ext === 'typ') language = 'typst';

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
            _id: docId,
            projectId: collaborationProjectId || node.projectId,
          });

          uiService.setResearchLayoutFocus('balanced');
          uiService.setWorkspaceMode('chat-editor');
        } catch (error) {
          console.error('[FileExplorer] Failed to read file:', error);
          uiService.addCompilationLog({
            type: 'error',
            message: `Cannot read file: ${node.name} - ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    },
    [collaborationProjectId, editorService, uiService, setSelectedNode]
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
