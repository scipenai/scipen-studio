/**
 * @file OutlinePanel.tsx - Document Outline Panel
 * @description Displays LaTeX document structure outline with click-to-navigate to sections
 */

import { ChevronDown, ChevronRight, FileText, Hash, List } from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useTranslation } from '../locales';
import { t as tDirect } from '../locales';
import { useActiveTabPath, useEditorTabs } from '../services/core';

interface OutlineItem {
  id: string;
  type: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph';
  title: string;
  line: number;
  level: number;
  children: OutlineItem[];
}

interface FlatOutlineItem {
  id: string;
  type: OutlineItem['type'];
  title: string;
  line: number;
  level: number;
  depth: number;
  number: string;
  hasChildren: boolean;
  isExpanded: boolean;
  parentId: string | null;
}

function parseLatexOutline(content: string): OutlineItem[] {
  const lines = content.split('\n');
  const outline: OutlineItem[] = [];
  const stack: { item: OutlineItem; level: number }[] = [];

  const sectionCommands: Record<string, { type: OutlineItem['type']; level: number }> = {
    '\\part': { type: 'part', level: 0 },
    '\\chapter': { type: 'chapter', level: 1 },
    '\\section': { type: 'section', level: 2 },
    '\\subsection': { type: 'subsection', level: 3 },
    '\\subsubsection': { type: 'subsubsection', level: 4 },
    '\\paragraph': { type: 'paragraph', level: 5 },
  };

  const sectionRegex =
    /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*\{([^}]*)\}/g;

  lines.forEach((line, index) => {
    // Skip comment lines
    if (line.trim().startsWith('%')) return;

    let match;
    sectionRegex.lastIndex = 0;

    while ((match = sectionRegex.exec(line)) !== null) {
      const command = `\\${match[1]}`;
      const title = match[2].trim();
      const config = sectionCommands[command];

      if (config) {
        const item: OutlineItem = {
          id: `outline-${index}-${match.index}`,
          type: config.type,
          title: title || tDirect('outline.untitled'),
          line: index + 1,
          level: config.level,
          children: [],
        };

        // Pop items with deeper or equal level
        while (stack.length > 0 && stack[stack.length - 1].level >= config.level) {
          stack.pop();
        }

        // Add to parent or root
        if (stack.length > 0) {
          stack[stack.length - 1].item.children.push(item);
        } else {
          outline.push(item);
        }

        stack.push({ item, level: config.level });
      }
    }
  });

  return outline;
}

function formatSectionNumber(index: number, parentNumber?: string): string {
  const num = index + 1;
  return parentNumber ? `${parentNumber}.${num}` : `${num}`;
}

// Flatten tree structure considering expanded state
function flattenOutline(
  items: OutlineItem[],
  expandedIds: Set<string>,
  depth = 0,
  parentNumber = '',
  parentId: string | null = null
): FlatOutlineItem[] {
  const result: FlatOutlineItem[] = [];

  items.forEach((item, index) => {
    const number = formatSectionNumber(index, parentNumber || undefined);
    const hasChildren = item.children.length > 0;
    const isExpanded = expandedIds.has(item.id);

    result.push({
      id: item.id,
      type: item.type,
      title: item.title,
      line: item.line,
      level: item.level,
      depth,
      number,
      hasChildren,
      isExpanded,
      parentId,
    });

    // Recursively add children if expanded
    if (hasChildren && isExpanded) {
      result.push(...flattenOutline(item.children, expandedIds, depth + 1, number, item.id));
    }
  });

  return result;
}

function getAllItemIds(items: OutlineItem[]): string[] {
  const ids: string[] = [];
  items.forEach((item) => {
    ids.push(item.id);
    if (item.children.length > 0) {
      ids.push(...getAllItemIds(item.children));
    }
  });
  return ids;
}

// Level styles using CSS variables
const levelStyles: Record<string, string> = {
  part: 'text-[var(--color-text-primary)] font-semibold',
  chapter: 'text-[var(--color-text-primary)] font-medium',
  section: 'text-[var(--color-text-secondary)]',
  subsection: 'text-[var(--color-text-secondary)]',
  subsubsection: 'text-[var(--color-text-muted)]',
  paragraph: 'text-[var(--color-text-muted)] text-xs',
};

interface OutlineRowProps {
  item: FlatOutlineItem;
  onNavigate: (line: number) => void;
  onToggle: (id: string) => void;
}

const OutlineRow: React.FC<OutlineRowProps> = memo(({ item, onNavigate, onToggle }) => {
  const handleClick = () => {
    onNavigate(item.line);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(item.id);
  };

  return (
    <div
      onClick={handleClick}
      className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-[var(--color-bg-hover)] cursor-pointer transition-colors group select-none"
      style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
    >
      {item.hasChildren ? (
        <button
          onClick={handleToggle}
          className="w-4 h-4 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
        >
          {item.isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      ) : (
        <span className="w-4" />
      )}

      <span className="text-xs text-[var(--color-text-muted)] font-mono min-w-[2rem]">
        {item.number}.
      </span>

      <span
        className={`text-xs truncate flex-1 ${levelStyles[item.type] || 'text-[var(--color-text-secondary)]'}`}
      >
        {item.title}
      </span>
    </div>
  );
});

OutlineRow.displayName = 'OutlineRow';

export const OutlinePanel: React.FC = () => {
  const activeTabPath = useActiveTabPath();
  const openTabs = useEditorTabs();

  const { t } = useTranslation();

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  const activeContent = useMemo(() => {
    if (!activeTabPath) return '';
    const tab = openTabs.find((t) => t.path === activeTabPath);
    return tab?.content || '';
  }, [activeTabPath, openTabs]);

  const outline = useMemo(() => {
    if (!activeContent) return [];
    return parseLatexOutline(activeContent);
  }, [activeContent]);

  // Expand all items on initialization
  useMemo(() => {
    if (outline.length > 0 && !initialized) {
      const allIds = getAllItemIds(outline);
      setExpandedIds(new Set(allIds));
      setInitialized(true);
    }
  }, [outline, initialized]);

  // Reset initialization state when file changes
  useEffect(() => {
    setInitialized(false);
  }, [activeTabPath]);

  const flatItems = useMemo(() => {
    return flattenOutline(outline, expandedIds);
  }, [outline, expandedIds]);

  const handleToggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((line: number) => {
    // Dispatch editor navigation event
    window.dispatchEvent(
      new CustomEvent('outline-navigate', {
        detail: { line },
      })
    );
  }, []);

  const renderRow = useCallback(
    (_index: number, item: FlatOutlineItem) => (
      <OutlineRow key={item.id} item={item} onNavigate={handleNavigate} onToggle={handleToggle} />
    ),
    [handleNavigate, handleToggle]
  );

  const isLatexFile = activeTabPath?.endsWith('.tex') || activeTabPath?.endsWith('.latex');

  if (!activeTabPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-muted)] text-xs p-4">
        <FileText className="w-8 h-8 mb-2 opacity-40" />
        <p>{t('outline.noFileOpen')}</p>
      </div>
    );
  }

  if (!isLatexFile) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-muted)] text-xs p-4">
        <Hash className="w-8 h-8 mb-2 opacity-40" />
        <p>{t('outline.latexOnly')}</p>
      </div>
    );
  }

  if (outline.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-muted)] text-xs p-4">
        <List className="w-8 h-8 mb-2 opacity-40" />
        <p>{t('outline.noSections')}</p>
        <p className="text-[var(--color-text-disabled)] mt-1 text-center">
          {t('outline.addSectionHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex-shrink-0">
        <h3 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {t('outline.count', { count: String(flatItems.length) })}
        </h3>
      </div>

      <div className="flex-1 overflow-hidden">
        <Virtuoso
          data={flatItems}
          itemContent={renderRow}
          className="h-full"
          style={{ height: '100%' }}
          increaseViewportBy={{ top: 50, bottom: 50 }}
        />
      </div>
    </div>
  );
};
