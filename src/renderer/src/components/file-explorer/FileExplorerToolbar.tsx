/**
 * @file FileExplorerToolbar.tsx - Toolbar and empty state renders for FileExplorer
 * @description Toolbar buttons (new file, new folder, refresh, upload, sync) and empty/loading state placeholders.
 */

import { clsx } from 'clsx';
import { FileText, FolderOpen, FolderPlus, Plus, RefreshCw } from 'lucide-react';
import type React from 'react';
import type { FileNode } from '../../types';
import { api } from '../../api';
import { bootstrapProject } from '../../services/core/FileOpenService';
import { FileTreeSkeleton } from '../ui/Skeleton';
import { getParentPath } from './utils/file-path';
import type { RefreshReason } from './hooks/useFileTreeRefresh';

// ====== Empty States ======

export const NoProjectState: React.FC = () => (
  <div className="h-full flex flex-col items-center justify-center p-6">
    <div
      className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6"
      style={{
        background:
          'linear-gradient(135deg, rgba(34, 211, 238, 0.1) 0%, rgba(56, 189, 248, 0.1) 100%)',
      }}
    >
      <FolderOpen size={36} style={{ color: 'var(--color-text-muted)' }} />
    </div>
    <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
      No project open
    </h3>
    <p
      className="text-xs text-center max-w-[200px] mb-6"
      style={{ color: 'var(--color-text-muted)' }}
    >
      Open a folder to start editing, or select from recent projects
    </p>
    <div className="flex flex-col gap-2 w-full max-w-[180px]">
      <button
        onClick={async () => {
          const result = await api.project.open();
          if (result) {
            await bootstrapProject(result.projectPath, result.fileTree as FileNode);
          }
        }}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
        style={{
          background: 'var(--color-accent-muted)',
          color: 'var(--color-accent)',
          border: '1px solid var(--color-accent)',
        }}
      >
        <FolderOpen size={16} />
        Open Folder
      </button>
    </div>
  </div>
);

export const LoadingSkeletonState: React.FC = () => (
  <div className="h-full flex flex-col">
    <div
      className="flex items-center justify-between px-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-16 h-4 rounded animate-pulse"
          style={{ background: 'var(--color-bg-tertiary)' }}
        />
      </div>
      <div className="flex items-center gap-1">
        <div
          className="w-6 h-6 rounded animate-pulse"
          style={{ background: 'var(--color-bg-tertiary)' }}
        />
        <div
          className="w-6 h-6 rounded animate-pulse"
          style={{ background: 'var(--color-bg-tertiary)' }}
        />
        <div
          className="w-6 h-6 rounded animate-pulse"
          style={{ background: 'var(--color-bg-tertiary)' }}
        />
      </div>
    </div>
    <FileTreeSkeleton rows={10} />
  </div>
);

export const LoadingState: React.FC = () => (
  <div className="h-full flex flex-col items-center justify-center p-6">
    <div
      className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
      style={{
        background:
          'linear-gradient(135deg, rgba(34, 211, 238, 0.1) 0%, rgba(56, 189, 248, 0.1) 100%)',
      }}
    >
      <FileText size={28} style={{ color: 'var(--color-text-muted)' }} />
    </div>
    <p className="text-sm font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
      Loading project...
    </p>
    <p className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
      Please wait
    </p>
  </div>
);

// ====== Toolbar ======

interface ToolbarProps {
  projectPath: string;
  selectedNode: FileNode | null;
  isRefreshing: boolean;
  onRefresh: (reason: RefreshReason) => void;
  onNewFile: (path: string) => void;
  onNewFolder: (path: string) => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  projectPath,
  selectedNode,
  isRefreshing,
  onRefresh,
  onNewFile,
  onNewFolder,
}) => {
  return (
    <div
      className="flex items-center justify-between px-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="text-xs truncate font-medium"
          style={{
            color: 'var(--color-text-muted)',
          }}
        >
          {projectPath.split(/[/\\]/).pop()}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            const targetPath =
              selectedNode?.type === 'directory'
                ? selectedNode.path
                : selectedNode
                  ? getParentPath(selectedNode.path)
                  : projectPath;
            onNewFile(targetPath);
          }}
          className="p-1 rounded transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
          title="New File"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={() => {
            const targetPath =
              selectedNode?.type === 'directory'
                ? selectedNode.path
                : selectedNode
                  ? getParentPath(selectedNode.path)
                  : projectPath;
            onNewFolder(targetPath);
          }}
          className="p-1 rounded transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
          title="New Folder"
        >
          <FolderPlus size={14} />
        </button>
        <button
          onClick={() => onRefresh('manual')}
          disabled={isRefreshing}
          className={clsx(
            'p-1 rounded transition-colors cursor-pointer',
            isRefreshing && 'animate-spin'
          )}
          style={{ color: 'var(--color-text-muted)' }}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>
    </div>
  );
};
