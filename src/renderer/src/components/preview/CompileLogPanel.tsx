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
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useTranslation } from '../../locales';
import type { ParsedLogEntry } from '../../types';

function normalizeParsedEntry(entry: ParsedLogEntry, fallbackMessage: string): ParsedLogEntry {
  const normalizeText = (value: unknown, fallback = ''): string => {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      if (typeof objectValue.message === 'string') {
        return objectValue.message;
      }
      try {
        return JSON.stringify(objectValue);
      } catch {
        return fallback || String(value);
      }
    }
    if (value == null) {
      return fallback;
    }
    return String(value);
  };

  return {
    ...entry,
    file: entry.file ? normalizeText(entry.file) : '',
    message: normalizeText(entry.message, fallbackMessage),
    content: normalizeText(entry.content, ''),
    raw: normalizeText(entry.raw, ''),
  };
}

interface CompileLogPanelProps {
  errors?: ParsedLogEntry[];
  warnings?: ParsedLogEntry[];
  info?: ParsedLogEntry[];
  /** Full raw compiler output — rendered as a collapsible section. */
  rawLog?: string;
  onJumpToLine?: (file: string, line: number) => void;
  onClose?: () => void;
  embedded?: boolean;
  showHeader?: boolean;
}

type LogFilter = 'all' | 'errors' | 'warnings' | 'info';

// Use virtualization when exceeding this threshold
const VIRTUALIZATION_THRESHOLD = 50;

export const CompileLogPanel: React.FC<CompileLogPanelProps> = ({
  errors = [],
  warnings = [],
  info = [],
  rawLog,
  onJumpToLine,
  onClose,
  embedded = false,
  showHeader = true,
}) => {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // Raw logs render expanded by default — Overleaf mounts them as an
  // always-expanded entry at the bottom of the "all" tab
  // (`alwaysExpandRawContent`), never behind a collapsed footer toggle.
  const [rawOpen, setRawOpen] = useState(true);
  const { t } = useTranslation();
  const unknownLogFallback = t('compileLog.unknownLog');
  const normalizedErrors = useMemo(
    () => errors.map((e) => normalizeParsedEntry(e, unknownLogFallback)),
    [errors, unknownLogFallback]
  );
  const normalizedWarnings = useMemo(
    () => warnings.map((e) => normalizeParsedEntry(e, unknownLogFallback)),
    [warnings, unknownLogFallback]
  );
  const normalizedInfo = useMemo(
    () => info.map((e) => normalizeParsedEntry(e, unknownLogFallback)),
    [info, unknownLogFallback]
  );
  const filteredItems = useMemo(() => {
    switch (filter) {
      case 'errors':
        return normalizedErrors;
      case 'warnings':
        return normalizedWarnings;
      case 'info':
        return normalizedInfo;
      default:
        return [...normalizedErrors, ...normalizedWarnings, ...normalizedInfo];
    }
  }, [filter, normalizedErrors, normalizedWarnings, normalizedInfo]);

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

  const totalCount = normalizedErrors.length + normalizedWarnings.length + normalizedInfo.length;

  const renderLogItem = useCallback(
    (index: number, entry: ParsedLogEntry) => {
      const id = `${entry.level}-${index}`;
      const isExpanded = expandedItems.has(id);
      const hasContent = entry.content && entry.content.trim().length > 0;
      const fileLabel = entry.file?.startsWith('./') ? entry.file.slice(2) : entry.file;
      const jumpLabel =
        fileLabel && entry.line ? `Open ${fileLabel} line ${entry.line}` : (fileLabel ?? '');

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
                type="button"
                aria-label={isExpanded ? 'Collapse log details' : 'Expand log details'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(id);
                }}
                className="mt-0.5 cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] rounded"
              >
                {isExpanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
              </button>
            ) : (
              <span className="w-3.5" />
            )}

            <span className="mt-0.5">{getLevelIcon(entry.level || 'info')}</span>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm">
                {entry.file && (
                  <button
                    type="button"
                    aria-label={jumpLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleJumpToLine(entry);
                    }}
                    className={clsx(
                      'flex items-center gap-1 text-xs px-1.5 py-0.5 rounded',
                      entry.line
                        ? 'cursor-pointer bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]'
                        : 'cursor-not-allowed bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]'
                    )}
                    disabled={!entry.line}
                  >
                    <FileText size={10} aria-hidden="true" />
                    <span className="truncate max-w-32">{fileLabel}</span>
                    {entry.line && (
                      <span className="text-[var(--color-accent)]">:{entry.line}</span>
                    )}
                  </button>
                )}
              </div>

              <p className="text-sm text-[var(--color-text-secondary)] mt-1 break-words">
                {entry.message}
              </p>
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
    [expandedItems, getLevelColor, getLevelIcon, handleJumpToLine, toggleExpand]
  );

  // Stable Footer identity: an inline component here would remount the raw
  // log (tens of KB of <pre>) on every unrelated re-render (entry expand,
  // filter change), resetting its scroll position. Must stay ABOVE the
  // early return below — hooks may not be conditional.
  const virtuosoFooter = useMemo(() => {
    const Footer = () =>
      filter === 'all' && rawLog?.trim() ? (
        <RawLogSection rawLog={rawLog} open={rawOpen} onToggle={() => setRawOpen((v) => !v)} />
      ) : null;
    return Footer;
  }, [filter, rawLog, rawOpen]);

  if (totalCount === 0 && !rawLog?.trim()) {
    return null;
  }

  // Embedded mode (no-PDF failure pane): the host is an auto-height scroll
  // container, so h-full/Virtuoso percentage heights collapse — use a plain
  // capped scroll list instead. Full mode virtualizes as before.
  const useVirtualization = !embedded && filteredItems.length > VIRTUALIZATION_THRESHOLD;

  return (
    <div
      className={clsx(
        // Full mode fills the pane Overleaf-style — the parent decides the
        // footprint (full-size overlay of the preview viewer area).
        embedded ? 'flex min-h-0 max-h-96 flex-col' : 'flex h-full min-h-0 flex-col',
        embedded
          ? 'bg-transparent border-0'
          : 'bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)]'
      )}
    >
      {showHeader && (
        <div
          className={clsx(
            'flex items-center justify-between px-3 py-2',
            embedded
              ? 'border-b border-[rgba(15,23,42,0.06)] bg-transparent'
              : 'border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/50'
          )}
        >
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
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="p-1 rounded cursor-pointer hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className={clsx('overflow-hidden', embedded ? 'min-h-0 flex-1' : 'flex-1 min-h-0')}>
        {useVirtualization ? (
          <Virtuoso
            data={filteredItems}
            itemContent={renderLogItem}
            className="h-full"
            style={{ height: '100%' }}
            increaseViewportBy={{ top: 100, bottom: 100 }}
            components={{ Footer: virtuosoFooter }}
          />
        ) : (
          <div className={embedded ? 'overflow-y-auto' : 'h-full overflow-y-auto'}>
            {filteredItems.length === 0 && !(filter === 'all' && rawLog?.trim()) ? (
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
            ) : (
              <>
                {filteredItems.map((entry, index) => renderLogItem(index, entry))}
                {filter === 'all' && rawLog?.trim() && (
                  <RawLogSection
                    rawLog={rawLog}
                    open={rawOpen}
                    onToggle={() => setRawOpen((v) => !v)}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The full raw compiler output, mounted as the last entry of the "all" list
 * (Overleaf's raw-logs placement) and expanded by default — the diagnostics
 * rows above are deduplicated summaries, so the raw log is the only place
 * the complete compile output is visible.
 */
const RawLogSection: React.FC<{ rawLog: string; open: boolean; onToggle: () => void }> = ({
  rawLog,
  open,
  onToggle,
}) => {
  const { t } = useTranslation();
  return (
    <div className="border-t border-[var(--color-border)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        <span className="font-medium">{t('pdfPreview.rawLogs')}</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {rawLog.length.toLocaleString()} chars
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 pb-3 pt-1 font-mono text-xs leading-5 text-[var(--color-text-muted)]">
          {rawLog.trim()}
        </pre>
      )}
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
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={clsx(
      'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]',
      active
        ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
        : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
    )}
  >
    <span className={active ? 'text-[var(--color-text-primary)]' : color}>{count}</span>
    <span>{label}</span>
  </button>
);
