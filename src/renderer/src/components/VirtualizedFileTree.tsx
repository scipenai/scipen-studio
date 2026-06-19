/**
 * @file VirtualizedFileTree.tsx - Virtualized File Tree
 * @description Virtual scroll optimized file tree component for high-performance rendering of large projects
 */

import { clsx } from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  File,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Loader2,
} from 'lucide-react';
import React, { useState, useCallback, useMemo, memo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useTranslation } from '../locales';
import type { FileNode } from '../types';

interface FlattenedNode {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  isLoading?: boolean;
}

export type FileTreeContextMenuEvent =
  | React.MouseEvent
  | {
      type: 'keyboard';
      clientX: number;
      clientY: number;
      preventDefault: () => void;
      stopPropagation: () => void;
    };

interface VirtualizedFileTreeProps {
  fileTree: FileNode | null;
  selectedPath: string | null;
  activeTabPath: string | null;
  onSelect: (node: FileNode) => void;
  onContextMenu: (e: FileTreeContextMenuEvent, node: FileNode) => void;
  renamingPath: string | null;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  /** Called when expanding an unresolved directory to trigger lazy loading */
  onResolveChildren?: (dirPath: string) => Promise<void>;
}

const getFileIcon = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'tex':
    case 'latex':
      return <FileCode size={16} className="text-[var(--color-success)]" aria-hidden="true" />;
    case 'bib':
      return <FileText size={16} className="text-[var(--color-warning)]" aria-hidden="true" />;
    case 'pdf':
      return <FileText size={16} className="text-[var(--color-error)]" aria-hidden="true" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return <Image size={16} className="text-[var(--color-info)]" aria-hidden="true" />;
    case 'md':
      return <FileText size={16} className="text-[var(--color-accent)]" aria-hidden="true" />;
    case 'sty':
    case 'cls':
      return <FileCode size={16} className="text-[var(--color-warning)]" aria-hidden="true" />;
    default:
      return <File size={16} className="text-[var(--color-text-muted)]" aria-hidden="true" />;
  }
};

const InlineInput: React.FC<{
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}> = memo(({ defaultValue, onSubmit, onCancel }) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (value.trim()) onSubmit(value.trim());
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (value.trim()) onSubmit(value.trim());
        else onCancel();
      }}
      className="w-full rounded px-2 py-0.5 text-sm outline-none"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-accent)',
        color: 'var(--color-text-primary)',
      }}
    />
  );
});
InlineInput.displayName = 'InlineInput';

// Callbacks receive path/node as parameters to avoid creating closures in parent component
const FileTreeRow = memo<{
  item: FlattenedNode;
  isSelected: boolean;
  isActive: boolean;
  isRenaming: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: FileNode) => void;
  onContextMenu: (e: FileTreeContextMenuEvent, node: FileNode) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
}>(
  ({
    item,
    isSelected,
    isActive,
    isRenaming,
    onToggle,
    onSelect,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
  }) => {
    const { node, depth, isExpanded, hasChildren, isLoading } = item;
    const isDirectory = node.type === 'directory';

    const handleClick = useCallback(() => {
      // Select both files and directories on click (VS Code behavior)
      onSelect(node);
      if (isDirectory) {
        onToggle(node.path);
      }
    }, [isDirectory, onToggle, onSelect, node]);

    const handleDoubleClick = useCallback(() => {
      if (!isDirectory) {
        onSelect(node);
      }
    }, [isDirectory, onSelect, node]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          const rowRect = e.currentTarget.getBoundingClientRect();
          onContextMenu(
            {
              type: 'keyboard',
              clientX: rowRect.left + 16,
              clientY: rowRect.top + rowRect.height / 2,
              preventDefault: () => undefined,
              stopPropagation: () => undefined,
            },
            node
          );
          return;
        }

        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onSelect(node);
        if (isDirectory) {
          onToggle(node.path);
        }
      },
      [isDirectory, node, onContextMenu, onSelect, onToggle]
    );

    const handleContextMenu = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, node);
      },
      [onContextMenu, node]
    );

    const handleRenameSubmit = useCallback(
      (newName: string) => {
        onRenameSubmit(node.path, newName);
      },
      [onRenameSubmit, node.path]
    );

    const fileIcon = useMemo(() => getFileIcon(node.name), [node.name]);

    return (
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected || isActive}
        aria-expanded={isDirectory && hasChildren ? isExpanded : undefined}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        className="group relative flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1 text-[13px] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        style={{
          paddingLeft: `${depth * 12 + 8}px`,
          background: isActive
            ? 'var(--color-accent-muted)'
            : isSelected
              ? 'var(--color-bg-hover)'
              : 'transparent',
          color: isActive
            ? 'var(--color-accent)'
            : isSelected
              ? 'var(--color-text-primary)'
              : 'var(--color-text-secondary)',
        }}
      >
        {isActive && (
          <div
            className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full"
            style={{ background: 'var(--color-accent)' }}
          />
        )}

        <div className="w-4 h-4 flex items-center justify-center">
          {isDirectory && hasChildren ? (
            isLoading ? (
              <Loader2
                size={14}
                className="animate-spin text-[var(--color-accent)]"
                aria-hidden="true"
              />
            ) : (
              <span
                className={clsx(
                  'transition-transform duration-200',
                  isExpanded
                    ? 'text-[var(--color-text-muted)]'
                    : 'text-[var(--color-text-disabled)] group-hover:text-[var(--color-text-muted)]'
                )}
              >
                {isExpanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
              </span>
            )
          ) : null}
        </div>

        <div className="flex-shrink-0 flex items-center justify-center">
          {isDirectory ? (
            isExpanded ? (
              <FolderOpen size={16} className="text-[var(--color-warning)]" aria-hidden="true" />
            ) : (
              <Folder size={16} className="text-[var(--color-warning)]/80" aria-hidden="true" />
            )
          ) : (
            <span className="flex-shrink-0 opacity-90 group-hover:opacity-100 transition-opacity">
              {fileIcon}
            </span>
          )}
        </div>

        {node.isRemote && (
          <Cloud
            size={12}
            className="text-[var(--color-success)]/80 flex-shrink-0"
            aria-hidden="true"
          />
        )}

        <div className="truncate flex-1 text-left min-w-0">
          {isRenaming ? (
            <InlineInput
              defaultValue={node.name}
              onSubmit={handleRenameSubmit}
              onCancel={onRenameCancel}
            />
          ) : (
            <span className={clsx('truncate', isActive ? 'font-medium' : 'font-normal')}>
              {node.name}
            </span>
          )}
        </div>
      </div>
    );
  }
);
FileTreeRow.displayName = 'FileTreeRow';

export const VirtualizedFileTree: React.FC<VirtualizedFileTreeProps> = ({
  fileTree,
  selectedPath,
  activeTabPath,
  onSelect,
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onResolveChildren,
}) => {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const { t } = useTranslation();

  const findNode = useCallback(
    (path: string): FileNode | null => {
      if (!fileTree) return null;

      const search = (node: FileNode): FileNode | null => {
        if (node.path === path) return node;
        if (node.children) {
          for (const child of node.children) {
            const found = search(child);
            if (found) return found;
          }
        }
        return null;
      };

      return search(fileTree);
    },
    [fileTree]
  );

  const toggleExpand = useCallback(
    async (path: string) => {
      const node = findNode(path);

      if (expandedPaths.has(path)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }

      // Check if lazy loading is needed (directory not resolved)
      if (node && node.type === 'directory' && node.isResolved === false && onResolveChildren) {
        setLoadingPaths((prev) => new Set(prev).add(path));

        try {
          await onResolveChildren(path);
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        }
      }

      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [expandedPaths, findNode, onResolveChildren]
  );

  const flattenedNodes = useMemo(() => {
    if (!fileTree) return [];

    const result: FlattenedNode[] = [];

    const flatten = (node: FileNode, depth: number) => {
      const isExpanded = expandedPaths.has(node.path);
      const isLoading = loadingPaths.has(node.path);

      // Show expand arrow if directory has children or is unresolved (needs lazy loading)
      const hasChildren = !!(
        node.type === 'directory' &&
        ((node.children && node.children.length > 0) || node.isResolved === false)
      );

      result.push({
        node,
        depth,
        isExpanded,
        hasChildren,
        isLoading,
      });

      // Only recurse into expanded directories that have resolved children
      if (isExpanded && node.children && node.children.length > 0) {
        // Sort: directories first, then files, same type sorted by name
        const sortedChildren = [...node.children].sort((a, b) => {
          if (a.type === b.type) {
            return a.name.localeCompare(b.name);
          }
          return a.type === 'directory' ? -1 : 1;
        });

        for (const child of sortedChildren) {
          flatten(child, depth + 1);
        }
      }
    };

    // Start from root's children (don't display root itself)
    if (fileTree.children) {
      const sortedChildren = [...fileTree.children].sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === 'directory' ? -1 : 1;
      });

      for (const child of sortedChildren) {
        flatten(child, 0);
      }
    }

    return result;
  }, [fileTree, expandedPaths, loadingPaths]);

  // Callbacks receive path/node as parameters to avoid creating closures here, ensuring FileTreeRow memo works correctly
  const renderRow = useCallback(
    (_index: number, item: FlattenedNode) => (
      <FileTreeRow
        item={item}
        isSelected={selectedPath === item.node.path}
        isActive={activeTabPath === item.node.path}
        isRenaming={renamingPath === item.node.path}
        onToggle={toggleExpand}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
      />
    ),
    [
      selectedPath,
      activeTabPath,
      renamingPath,
      toggleExpand,
      onSelect,
      onContextMenu,
      onRenameSubmit,
      onRenameCancel,
    ]
  );

  if (!fileTree || flattenedNodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--color-text-muted)] text-sm">
        <p>{t('fileTree.noFiles')}</p>
      </div>
    );
  }

  return (
    <Virtuoso
      data={flattenedNodes}
      itemContent={renderRow}
      className="h-full"
      style={{ height: '100%' }}
      role="tree"
      increaseViewportBy={{ top: 100, bottom: 100 }}
    />
  );
};
