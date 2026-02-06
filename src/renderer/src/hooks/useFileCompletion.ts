/**
 * @file useFileCompletion.ts - File completion Hook
 * @description Provides project file list for @ reference auto-completion, implemented using background file path indexing
 * @depends services/core/hooks
 */

import { useCallback, useMemo, useState } from 'react';
import { useFilePathIndex, useIsIndexing } from '../services/core/hooks';

// ====== Types ======

export interface CompletionItem {
  label: string;
  /** Relative path from project root */
  path: string;
  type: 'file' | 'directory';
  /** File extension or 'folder' */
  icon: string;
}

export interface UseFileCompletionReturn {
  items: CompletionItem[];
  filteredItems: CompletionItem[];
  setQuery: (query: string) => void;
  query: string;
  /** True while background indexing in progress */
  isLoading: boolean;
}

// ====== Helper Functions ======

function pathToCompletionItem(relativePath: string): CompletionItem {
  const isDirectory = relativePath.endsWith('/') || relativePath.endsWith('\\');
  const name = relativePath.split(/[/\\]/).pop() || relativePath;

  if (isDirectory) {
    return {
      label: name,
      path: relativePath,
      type: 'directory',
      icon: 'folder',
    };
  }

  const ext = name.split('.').pop()?.toLowerCase() || 'file';
  return {
    label: name,
    path: relativePath,
    type: 'file',
    icon: ext,
  };
}

/**
 * Checks if path should be excluded from completion.
 * Why segment-based: Prevents false positives like "my-node_modules-like" folder.
 */
function shouldFilterPath(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/);
  return segments.some((segment) => {
    const lowerSegment = segment.toLowerCase();
    return (
      lowerSegment === 'node_modules' ||
      lowerSegment === '.git' ||
      lowerSegment === '.svn' ||
      lowerSegment === '.hg'
    );
  });
}

function fuzzyMatch(query: string, target: string): boolean {
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  if (lowerTarget.includes(lowerQuery)) {
    return true;
  }

  const parts = lowerQuery.split(/[/\\]/);
  const targetParts = lowerTarget.split(/[/\\]/);

  const lastPart = parts[parts.length - 1];
  return targetParts.some((p) => p.includes(lastPart));
}

// ====== Hook Implementation ======

/**
 * Provides file completion for @ references using background file path index.
 * Why index-based: Ensures all files visible regardless of lazy loading state.
 */
export function useFileCompletion(maxResults = 50): UseFileCompletionReturn {
  const filePathIndex = useFilePathIndex();
  const isIndexing = useIsIndexing();
  const [query, setQuery] = useState('');

  const items = useMemo(() => {
    if (!filePathIndex || filePathIndex.length === 0) {
      return [];
    }

    const filtered = filePathIndex.filter((p) => !shouldFilterPath(p));
    return filtered.map(pathToCompletionItem);
  }, [filePathIndex]);

  const filteredItems = useMemo(() => {
    if (!query) {
      // No query: return shortest paths first (likely most relevant)
      return items
        .slice()
        .sort((a, b) => a.path.length - b.path.length)
        .slice(0, maxResults);
    }

    const matched = items.filter((item) => fuzzyMatch(query, item.path));

    // Sort by relevance: prefix matches first, then by path length
    return matched
      .sort((a, b) => {
        const aStartsWith = a.path.toLowerCase().startsWith(query.toLowerCase());
        const bStartsWith = b.path.toLowerCase().startsWith(query.toLowerCase());
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;
        return a.path.length - b.path.length;
      })
      .slice(0, maxResults);
  }, [items, query, maxResults]);

  const handleSetQuery = useCallback((q: string) => {
    setQuery(q);
  }, []);

  return {
    items,
    filteredItems,
    setQuery: handleSetQuery,
    query,
    isLoading: isIndexing,
  };
}
