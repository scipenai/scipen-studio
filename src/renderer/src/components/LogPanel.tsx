/**
 * @file LogPanel.tsx - System Log Panel
 * @description Displays compilation logs, errors and warnings with filtering and copy support
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useTranslation } from '../locales';
import {
  getUIService,
  useCompilationLogs,
  useCompilationResult,
  useIsCompiling,
} from '../services/core';

export interface LogEntry {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  details?: string;
}

export const LogPanel: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [panelHeight, setPanelHeight] = useState(200);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const resizeRef = useRef<HTMLDivElement>(null);

  const { t } = useTranslation();

  const compilationLogs = useCompilationLogs();
  const isCompiling = useIsCompiling();
  const compilationResult = useCompilationResult();

  const clearCompilationLogs = () => {
    getUIService().clearCompilationLogs();
  };

  // Drag to resize height
  useEffect(() => {
    const resizeHandle = resizeRef.current;
    if (!resizeHandle) return;

    let startY = 0;
    let startHeight = 0;

    const onMouseDown = (e: MouseEvent) => {
      startY = e.clientY;
      startHeight = panelHeight;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(500, startHeight + delta));
      setPanelHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    resizeHandle.addEventListener('mousedown', onMouseDown);
    return () => resizeHandle.removeEventListener('mousedown', onMouseDown);
  }, [panelHeight]);

  const getIcon = (type: LogEntry['type']) => {
    switch (type) {
      case 'success':
        return <CheckCircle size={14} className="text-[var(--color-success)]" aria-hidden="true" />;
      case 'error':
        return <AlertCircle size={14} className="text-[var(--color-error)]" aria-hidden="true" />;
      case 'warning':
        return <AlertTriangle size={14} className="text-[var(--color-warning)]" aria-hidden="true" />;
      default:
        return <Terminal size={14} className="text-[var(--color-text-muted)]" aria-hidden="true" />;
    }
  };

  const getTextClass = (type: LogEntry['type']) => {
    switch (type) {
      case 'success':
        return 'text-[var(--color-success)]';
      case 'error':
        return 'text-[var(--color-error)]';
      case 'warning':
        return 'text-[var(--color-warning)]';
      default:
        return 'text-[var(--color-text-secondary)]';
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (compilationLogs.length > 0 && isExpanded) {
      virtuosoRef.current?.scrollToIndex({
        index: compilationLogs.length - 1,
        behavior: 'smooth',
      });
    }
  }, [compilationLogs.length, isExpanded]);

  const renderLogItem = (_index: number, log: LogEntry) => {
    const content = (
      <>
        <span className="text-[var(--color-text-disabled)] flex-shrink-0">
          [{formatTime(log.timestamp)}]
        </span>
        {getIcon(log.type)}
        <span className={`${getTextClass(log.type)} break-all`}>{log.message}</span>
      </>
    );
    const className = `flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
      log.details ? 'cursor-pointer' : ''
    } ${selectedLog?.id === log.id ? 'bg-[var(--color-bg-tertiary)]' : ''}`;

    return log.details ? (
      <button
        key={log.id}
        type="button"
        onClick={() => setSelectedLog(log)}
        className={className}
      >
        {content}
      </button>
    ) : (
      <div key={log.id} className={className}>
        {content}
      </div>
    );
  };

  return (
    <div
      className="flex flex-col"
      style={{
        borderTop: '1px solid var(--color-border-subtle)',
        background: 'var(--color-bg-primary)',
      }}
    >
      <div
        ref={resizeRef}
        className="h-1 cursor-row-resize transition-colors"
        style={{ background: 'var(--color-border)' }}
      />

      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <div className="flex items-center gap-2">
          <Terminal size={14} style={{ color: 'var(--color-text-muted)' }} aria-hidden="true" />
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {t('logPanel.title')}
          </span>
          {isCompiling && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
              className="w-3 h-3 rounded-full"
              style={{
                border: '2px solid var(--color-accent)',
                borderTopColor: 'transparent',
              }}
            />
          )}
          {compilationResult && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                background: compilationResult.success
                  ? 'var(--color-success-muted)'
                  : 'var(--color-error-muted)',
                color: compilationResult.success ? 'var(--color-success)' : 'var(--color-error)',
              }}
            >
              {compilationResult.success ? t('logPanel.success') : t('logPanel.failed')}
              {compilationResult.time && ` (${(compilationResult.time / 1000).toFixed(2)}s)`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('logPanel.clearLog')}
            onClick={clearCompilationLogs}
            className="p-1 rounded transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            style={{ color: 'var(--color-text-muted)' }}
            title={t('logPanel.clearLog')}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={isExpanded ? t('logPanel.collapse') : t('logPanel.expand')}
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            style={{ color: 'var(--color-text-muted)' }}
            title={isExpanded ? t('logPanel.collapse') : t('logPanel.expand')}
          >
            {isExpanded ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronUp size={14} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: panelHeight }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="flex h-full">
              <div
                className="flex-1 overflow-hidden font-mono text-xs p-2"
                style={{ height: panelHeight }}
              >
                {compilationLogs.length === 0 ? (
                  <div className="text-center py-8" style={{ color: 'var(--color-text-disabled)' }}>
                    {t('logPanel.noLogs')}
                  </div>
                ) : (
                  <Virtuoso
                    ref={virtuosoRef}
                    data={compilationLogs}
                    itemContent={renderLogItem}
                    followOutput="auto"
                    className="h-full"
                    style={{ height: '100%' }}
                    increaseViewportBy={{ top: 50, bottom: 50 }}
                  />
                )}
              </div>

              <AnimatePresence>
                {selectedLog?.details && (
                  <motion.div
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 350, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    className="flex flex-col overflow-hidden"
                    style={{
                      borderLeft: '1px solid var(--color-border-subtle)',
                      background: 'var(--color-bg-tertiary)',
                    }}
                  >
                    <div
                      className="flex items-center justify-between px-2 py-1"
                      style={{
                        background: 'var(--color-bg-secondary)',
                        borderBottom: '1px solid var(--color-border-subtle)',
                      }}
                    >
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {t('logPanel.details')}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={t('logPanel.copy')}
                          onClick={() => copyToClipboard(selectedLog.details || '')}
                          className="p-1 cursor-pointer hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                          title={t('logPanel.copy')}
                        >
                          <Copy size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="Close details"
                          onClick={() => setSelectedLog(null)}
                          className="p-1 cursor-pointer hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <pre className="flex-1 overflow-auto p-2 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap">
                      {selectedLog.details}
                    </pre>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
