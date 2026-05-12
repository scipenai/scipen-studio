/** @file useFileCreateRename.ts - Create and rename file operations */

import { useCallback } from 'react';
import type { FileNode } from '../../../types';
import {
  getEditorService,
  getFileExplorerService,
  getProjectRuntimeContext,
  getUIService,
  useFileTree,
} from '../../../services/core';
import { validateFileName } from '../../../utils/fileValidation';
import { triggerOverleafNewFileSync } from '../../../utils/overleaf-sync-helper';
import {
  getOverleafSyncContext,
  persistOverleafDocMap,
  resolveOverleafFolderId,
  resolveOverleafEntity,
  syncOverleafEntityOp,
} from '../utils/overleaf-sync';

interface UseFileCreateRenameOptions {
  collaborationProjectId: string | null;
  refreshFileTree: (reason?: 'manual' | 'focus' | 'auto') => Promise<void>;
  setRenamingPath: (path: string | null) => void;
}

export function useFileCreateRename({
  collaborationProjectId,
  refreshFileTree,
  setRenamingPath,
}: UseFileCreateRenameOptions) {
  const fileTree = useFileTree();
  const editorService = getEditorService();
  const uiService = getUIService();

  // ====== Create ======

  const handleCreateSubmit = useCallback(
    async (name: string, creatingIn: { path: string; type: 'file' | 'folder' }) => {
      const siblingNames: string[] = [];
      if (fileTree) {
        const findParentChildren = (nodes: FileNode[], targetPath: string): FileNode[] => {
          for (const node of nodes) {
            if (node.path === targetPath && node.children) return node.children;
            if (node.children) {
              const found = findParentChildren(node.children, targetPath);
              if (found.length > 0) return found;
            }
          }
          return [];
        };
        const siblings = findParentChildren([fileTree], creatingIn.path);
        siblingNames.push(...siblings.map((s) => s.name));
      }

      const validation = validateFileName(name, siblingNames);
      if (!validation.valid) {
        uiService.addCompilationLog({
          type: 'error',
          message: validation.error || 'Invalid file name',
        });
        return;
      }
      if (validation.warning) {
        uiService.addCompilationLog({ type: 'warning', message: validation.warning });
      }

      const newPath = `${creatingIn.path}/${name}`.replace(/\\/g, '/');
      const createType = creatingIn.type;

      try {
        const fileService = getFileExplorerService();
        let createdEntityId: string | undefined;

        if (createType === 'file') {
          const result = await fileService.createFile(creatingIn.path, name);
          if (!result.success) throw new Error(result.error);
          createdEntityId = result.entityId;
          uiService.addCompilationLog({ type: 'success', message: `Created file: ${name}` });
          if (collaborationProjectId) {
            getProjectRuntimeContext().update({ fileId: result.entityId || '' });
          }
        } else {
          const result = await fileService.createFolder(creatingIn.path, name);
          if (!result.success) throw new Error(result.error);
          uiService.addCompilationLog({ type: 'success', message: `Created folder: ${name}` });
        }

        // After creation, always route through the local-first new-file sync pipeline to avoid
        // divergent root-relative-path / parent-directory resolution.
        void triggerOverleafNewFileSync(newPath, createType === 'folder');

        refreshFileTree();

        if (createType === 'file') {
          const ext = name.split('.').pop()?.toLowerCase();
          let language = 'plaintext';
          if (ext === 'tex' || ext === 'latex') language = 'latex';
          else if (ext === 'bib') language = 'bibtex';
          else if (ext === 'md') language = 'markdown';
          else if (ext === 'sty' || ext === 'cls') language = 'latex';
          else if (ext === 'typ') language = 'typst';

          editorService.addTab({
            path: newPath,
            name,
            content: '',
            isDirty: false,
            language,
            _id: collaborationProjectId ? createdEntityId : undefined,
            projectId: collaborationProjectId || undefined,
          });
        }
      } catch (error) {
        uiService.addCompilationLog({ type: 'error', message: `Create failed: ${error}` });
      }
    },
    [fileTree, collaborationProjectId, editorService, uiService, refreshFileTree]
  );

  // ====== Rename ======

  const handleRenameSubmit = useCallback(
    async (oldPath: string, newName: string) => {
      const findNode = (nodes: FileNode[], path: string): FileNode | null => {
        for (const node of nodes) {
          if (node.path === path) return node;
          if (node.children) {
            const found = findNode(node.children, path);
            if (found) return found;
          }
        }
        return null;
      };

      const node = fileTree ? findNode([fileTree], oldPath) : null;
      const oldName = node?.name || oldPath.split(/[/\\]/).pop() || '';

      if (newName === oldName) {
        setRenamingPath(null);
        return;
      }

      const siblingNames: string[] = [];
      if (fileTree && node) {
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const findParentChildren = (nodes: FileNode[], targetPath: string): FileNode[] => {
          for (const n of nodes) {
            if (n.path === targetPath && n.children) return n.children;
            if (n.children) {
              const found = findParentChildren(n.children, targetPath);
              if (found.length > 0) return found;
            }
          }
          return [];
        };
        const siblings = findParentChildren([fileTree], parentPath);
        siblingNames.push(...siblings.map((s) => s.name));
      }

      const validation = validateFileName(newName, siblingNames, oldName);
      if (!validation.valid) {
        uiService.addCompilationLog({
          type: 'error',
          message: validation.error || 'Invalid file name',
        });
        return;
      }
      if (validation.warning) {
        uiService.addCompilationLog({ type: 'warning', message: validation.warning });
      }

      setRenamingPath(null);

      const entityType =
        node && collaborationProjectId
          ? node.type === 'directory'
            ? 'folder'
            : 'file'
          : undefined;

      const result = await getFileExplorerService().renameNode(
        oldPath,
        newName,
        entityType as 'doc' | 'file' | 'folder' | undefined,
        node?._id
      );

      if (result.success) {
        uiService.addCompilationLog({ type: 'success', message: `Renamed to: ${newName}` });

        // Overleaf local-first: update docIdMap after rename (folder renames must rewrite all descendants).
        const collabRename = getProjectRuntimeContext().state;
        if (collabRename.overleafProjectId && collabRename.rootPath) {
          const rootNorm = collabRename.rootPath.replace(/\\/g, '/');
          const oldRelPath = oldPath.replace(/\\/g, '/').slice(rootNorm.length + 1);
          const parentDir = oldRelPath.substring(0, oldRelPath.lastIndexOf('/'));
          const newRelPath = parentDir ? `${parentDir}/${newName}` : newName;
          const updatedMap = { ...collabRename.overleafDocMap };
          let changed = false;
          const oldPrefix = `${oldRelPath}/`;
          const newPrefix = `${newRelPath}/`;
          for (const key of Object.keys(updatedMap)) {
            if (key === oldRelPath) {
              updatedMap[newRelPath] = updatedMap[oldRelPath];
              delete updatedMap[oldRelPath];
              changed = true;
            } else if (key.startsWith(oldPrefix)) {
              const newKey = newPrefix + key.slice(oldPrefix.length);
              updatedMap[newKey] = updatedMap[key];
              delete updatedMap[key];
              changed = true;
            }
          }
          // Immediately push the rename to Overleaf
          const ctx = getOverleafSyncContext();
          if (ctx) {
            const isFolder = node?.type === 'directory';
            let entityId = isFolder
              ? await resolveOverleafFolderId(ctx.projectId, oldRelPath)
              : (ctx.docMap[oldRelPath] ?? collabRename.overleafDocMap[oldRelPath]);
            let entityType: 'doc' | 'file' | 'folder' = isFolder ? 'folder' : 'doc';
            if (!entityId && !isFolder) {
              // Missing from docMap → likely a fileRef (image or other binary); auto-detect.
              const resolved = await resolveOverleafEntity(ctx.projectId, oldRelPath);
              if (resolved) {
                entityId = resolved.id;
                entityType = resolved.type;
              }
            }
            if (!changed && !isFolder && entityId && entityType === 'doc') {
              updatedMap[newRelPath] = entityId;
              delete updatedMap[oldRelPath];
              changed = true;
            }
            if (changed) {
              getProjectRuntimeContext().update({ overleafDocMap: updatedMap });
              await persistOverleafDocMap(collabRename.rootPath, updatedMap, (type, msg) =>
                uiService.addCompilationLog({ type, message: msg })
              );
            }
            if (entityId) {
              await syncOverleafEntityOp(
                'rename',
                {
                  projectId: ctx.projectId,
                  entityType,
                  entityId,
                  newName,
                },
                (type, msg) => uiService.addCompilationLog({ type, message: msg })
              );
            }
          }
        }
      } else if (result.error) {
        uiService.addCompilationLog({ type: 'error', message: result.error });
      }

      refreshFileTree();
    },
    [fileTree, collaborationProjectId, uiService, setRenamingPath, refreshFileTree]
  );

  return {
    handleCreateSubmit,
    handleRenameSubmit,
  };
}
