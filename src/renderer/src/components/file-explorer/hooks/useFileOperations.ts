/** @file useFileOperations.ts - Composite hook aggregating all file operations */

import type { MutableRefObject } from 'react';
import type { FileNode } from '../../../types';
import { useFileDeletePaste } from './useFileDeletePaste';
import { useFileCreateRename } from './useFileCreateRename';

interface UseFileOperationsOptions {
  projectPath: string | null;
  selectedNodeRef: MutableRefObject<FileNode | null>;
  projectPathRef: MutableRefObject<string | null>;
  refreshFileTreeRef: MutableRefObject<(() => Promise<void>) | null>;
  refreshFileTree: (reason?: 'manual' | 'focus' | 'auto') => Promise<void>;
  setSelectedNode: (node: FileNode | null) => void;
  setRenamingPath: (path: string | null) => void;
}

export function useFileOperations({
  projectPath,
  selectedNodeRef,
  projectPathRef,
  refreshFileTreeRef,
  refreshFileTree,
  setSelectedNode,
  setRenamingPath,
}: UseFileOperationsOptions) {
  const { handleDeleteSelected, handleDelete, handlePasteToSelected, handlePaste } =
    useFileDeletePaste({
      projectPath,
      selectedNodeRef,
      projectPathRef,
      refreshFileTreeRef,
      refreshFileTree,
      setSelectedNode,
    });

  const { handleCreateSubmit, handleRenameSubmit } = useFileCreateRename({
    refreshFileTree,
    setRenamingPath,
  });

  return {
    handleDeleteSelected,
    handleDelete,
    handlePasteToSelected,
    handlePaste,
    handleCreateSubmit,
    handleRenameSubmit,
  };
}
