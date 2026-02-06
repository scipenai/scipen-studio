/**
 * @file CompileLogPanel.tsx - Compile Log Panel
 * @description Displays LaTeX compilation logs with click-to-navigate and virtual scroll optimization
 */

import { clsx } from 'clsx';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Sparkles,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useTranslation } from '../../locales';
import { type AskAIAboutErrorRequest, getUIService } from '../../services/core';
import type { ParsedLogEntry } from '../../types';

interface CompileLogPanelProps {
  errors?: ParsedLogEntry[];
  warnings?: ParsedLogEntry[];
  info?: ParsedLogEntry[];
  onJumpToLine?: (file: string, line: number) => void;
  onClose?: () => void;
  /** Compiler type (for AI error analysis) */
  compilerType?: 'LaTeX' | 'Typst';
  /** Callback to get source code context */
  getSourceContext?: (file: string, line: number) => string | undefined;
}

type LogFilter = 'all' | 'errors' | 'warnings' | 'info';

// Use virtualization when exceeding this threshold
const VIRTUALIZATION_THRESHOLD = 50;

export const CompileLogPanel: React.FC<CompileLogPanelProps> = ({
  errors = [],
  warnings = [],
  info = [],
  onJumpToLine,
  onClose,
  compilerType = 'LaTeX',
  getSourceContext,
}) => {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const { t } = useTranslation();
  const uiService = getUIService();

  const filteredItems = useMemo(() => {
    switch (filter) {
      case 'errors':
        return errors;
      case 'warnings':
        return warnings;
      case 'info':
        return info;
      default:
        return [...errors, ...warnings, ...info];
    }
  }, [filter, errors, warnings, info]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleJumpToLine = useCallback(
    (entry: ParsedLogEntry) => {
      if (entry.line && entry.file && onJumpToLine) {
        // Remove ./ prefix from file path
        const file = entry.file.startsWith('./') ? entry.file.slice(2) : entry.file;
        onJumpToLine(file, entry.line);
      }
    },
    [onJumpToLine]
  );

  const handleAskAI = useCallback(
    (entry: ParsedLogEntry) => {
      const file = entry.file?.startsWith('./') ? entry.file.slice(2) : entry.file;
      const sourceContext =
        file && entry.line && getSourceContext ? getSourceContext(file, entry.line) : undefined;

      const request: AskAIAboutErrorRequest = {
        errorMessage: entry.message,
        errorContent: entry.content?.trim(),
        file: file || undefined,
        line: entry.line || undefined,
        compilerType,
        sourceContext,
      };

      uiService.requestAIErrorAnalysis(request);
    },
    [compilerType, getSourceContext, uiService]
  );

  const getLevelIcon = useCallback((level: string) => {
    switch (level) {
      case 'error':
        return <AlertCircle size={14} className="text-[var(--color-error)] flex-shrink-0" />;
      case 'warning':
        return <AlertTriangle size={14} className="text-[var(--color-warning)] flex-shrink-0" />;
      default:
        return <Info size={14} className="text-[var(--color-info)] flex-shrink-0" />;
    }
  }, []);

  const getLevelColor = useCallback((level: string) => {
    switch (level) {
      case 'error':
        return 'border-l-[var(--color-error)]';
      case 'warning':
        return 'border-l-[var(--color-warning)]';
      default:
        return 'border-l-[var(--color-info)]';
    }
  }, []);

  const totalCount = errors.length + warnings.length + info.length;

  const renderLogItem = useCallback(
    (index: number, entry: ParsedLogEntry) => {
      const id = `${entry.level}-${index}`;
      const isExpanded = expandedItems.has(id);
      const hasContent = entry.content && entry.content.trim().length > 0;

      return (
        <div
          key={id}
          className={clsx(
            'border-l-2 border-b border-[var(--color-border)]',
            getLevelColor(entry.level || 'info')
          )}
        >
          <div
            className={clsx(
              'flex items-start gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)] cursor-pointer',
              entry.line && 'cursor-pointer'
            )}
            onClick={() => (hasContent ? toggleExpand(id) : handleJumpToLine(entry))}
          >
            {hasContent ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(id);
                }}
                className="mt-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <span className="w-3.5" />
            )}

            <span className="mt-0.5">{getLevelIcon(entry.level || 'info')}</span>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm">
                {entry.file && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleJumpToLine(entry);
                    }}
                    className={clsx(
                      'flex items-center gap-1 text-xs px-1.5 py-0.5 rounded',
                      entry.line
                        ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
                        : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]'
                    )}
                    disabled={!entry.line}
                  >
                    <FileText size={10} />
                    <span className="truncate max-w-32">
                      {entry.file.startsWith('./') ? entry.file.slice(2) : entry.file}
                    </span>
                    {entry.line && (
                      <span className="text-[var(--color-accent)]">:{entry.line}</span>
                    )}
                  </button>
                )}
              </div>

              <p className="text-sm text-[var(--color-text-secondary)] mt-1 break-words">
                {entry.message}
              </p>

              {entry.level === 'error' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAskAI(entry);
                  }}
                  className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors bg-[var(--color-accent-muted)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white"
                  title={t('compileLog.aiAnalyze')}
                >
                  <Sparkles size={12} />
                  <span>Ask AI</span>
                </button>
              )}
            </div>
          </div>

          {isExpanded && hasContent && (
            <div className="px-3 pb-2 pl-10">
              <pre className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-primary)] rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono">
                {entry.content?.trim()}
              </pre>
            </div>
          )}
        </div>
      );
    },
    [expandedItems, getLevelColor, getLevelIcon, handleJumpToLine, handleAskAI, toggleExpand, t]
  );

  if (totalCount === 0) {
    return null;
  }

  const useVirtualization = filteredItems.length > VIRTUALIZATION_THRESHOLD;

  return (
    <div className="bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] flex flex-col max-h-64">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/50">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">
            {t('compileLog.log')}
          </span>

          <div className="flex items-center gap-1">
            <FilterButton
              active={filter === 'all'}
              onClick={() => setFilter('all')}
              count={totalCount}
              label={t('compileLog.all')}
            />
            {errors.length > 0 && (
              <FilterButton
                active={filter === 'errors'}
                onClick={() => setFilter('errors')}
                count={errors.length}
                label={t('compileLog.errors')}
                color="text-[var(--color-error)]"
              />
            )}
            {warnings.length > 0 && (
              <FilterButton
                active={filter === 'warnings'}
                onClick={() => setFilter('warnings')}
                count={warnings.length}
                label={t('compileLog.warnings')}
                color="text-[var(--color-warning)]"
              />
            )}
            {info.length > 0 && (
              <FilterButton
                active={filter === 'info'}
                onClick={() => setFilter('info')}
                count={info.length}
                label={t('compileLog.info')}
                color="text-[var(--color-info)]"
              />
            )}
          </div>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-hidden" style={{ height: 200 }}>
        {filteredItems.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-[var(--color-text-muted)] text-sm">
            {t('compileLog.noLogs')}{' '}
            {filter === 'errors'
              ? t('compileLog.noErrors')
              : filter === 'warnings'
                ? t('compileLog.noWarnings')
                : filter === 'info'
                  ? t('compileLog.noInfo')
                  : t('compileLog.logs')}
          </div>
        ) : useVirtualization ? (
          <Virtuoso
            data={filteredItems}
            itemContent={renderLogItem}
            className="h-full"
            style={{ height: '100%' }}
            increaseViewportBy={{ top: 100, bottom: 100 }}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            {filteredItems.map((entry, index) => renderLogItem(index, entry))}
          </div>
        )}
      </div>
    </div>
  );
};

const FilterButton: React.FC<{
  active: boolean;
  onClick: () => void;
  count: number;
  label: string;
  color?: string;
}> = ({ active, onClick, count, label, color = 'text-[var(--color-text-muted)]' }) => (
  <button
    onClick={onClick}
    className={clsx(
      'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors',
      active
        ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
        : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
    )}
  >
    <span className={active ? 'text-[var(--color-text-primary)]' : color}>{count}</span>
    <span>{label}</span>
  </button>
);
