/**
 * @file LogService.ts - Log Service
 * @description Provides hierarchical logging, error tracking, and diagnostic capabilities with IPC persistence support
 * @depends IPC (api.system)
 */

import { api } from '../api';
import { generateId } from '../utils';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  details?: unknown;
  stack?: string;
  source?: string;
  /** For correlating related log entries */
  traceId?: string;
  /** Operation duration in ms */
  duration?: number;
}

export interface LogFilter {
  level?: LogLevel;
  category?: string;
  startTime?: number;
  endTime?: number;
  search?: string;
  regex?: RegExp;
  traceId?: string;
}

// Keywords for sensitive data detection
const SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'apiKey',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'auth',
  'credential',
  'private',
  'key',
  'cookie',
  'session',
  'jwt',
];

type LogListener = (entry: LogEntry) => void;

import type { IDisposable } from '../../../../shared/utils';

// ====== Log Service Implementation ======

class LogServiceImpl implements IDisposable {
  private logs: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private maxLogs = 1000;
  private minLevel: LogLevel = 'info';
  private currentTraceId: string | null = null;
  private _isDisposed = false;

  private timers: Map<string, number> = new Map();

  // Batch write buffer for IPC persistence
  private pendingLogs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    category: string;
    message: string;
    timestamp: number;
    details?: unknown;
  }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 2000;
  private readonly FLUSH_THRESHOLD = 10;

  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };

  /**
   * Clean up timers and flush pending logs
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining logs synchronously (best effort)
    this.flushToFile().catch(() => {});

    this.listeners.clear();
    this.timers.clear();
  }

  /** Filter sensitive information from log data */
  private sanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return obj;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitize(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sk) => keyLower.includes(sk));

      if (isSensitive) {
        // Sanitize sensitive values
        if (typeof value === 'string' && value.length > 0) {
          sanitized[key] = value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
        } else if (typeof value === 'boolean') {
          sanitized[key] = value ? '[CONFIGURED]' : '[NOT SET]';
        } else {
          sanitized[key] = '[REDACTED]';
        }
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setMaxLogs(max: number): void {
    this.maxLogs = max;
    this.trimLogs();
  }

  /** Set trace ID for correlating related operations */
  setTraceId(traceId: string | null): void {
    this.currentTraceId = traceId;
  }

  generateTraceId(): string {
    const traceId = generateId('trace');
    this.currentTraceId = traceId;
    return traceId;
  }

  startTimer(name: string): void {
    this.timers.set(name, performance.now());
  }

  /** End timer and return elapsed time in ms */
  endTimer(name: string): number {
    const startTime = this.timers.get(name);
    if (startTime === undefined) {
      return 0;
    }
    const duration = performance.now() - startTime;
    this.timers.delete(name);
    return Math.round(duration);
  }

  logWithDuration(
    level: LogLevel,
    category: string,
    message: string,
    timerName: string,
    details?: unknown
  ): void {
    const duration = this.endTimer(timerName);
    this.log(level, category, `${message} (${duration}ms)`, {
      ...(this.sanitize(details) as object),
      duration,
    });
  }

  log(level: LogLevel, category: string, message: string, details?: unknown): void {
    if (this.levelPriority[level] < this.levelPriority[this.minLevel]) {
      return;
    }

    // Filter sensitive information from details
    const sanitizedDetails = this.sanitize(details);

    const entry: LogEntry = {
      id: generateId('log'),
      timestamp: Date.now(),
      level,
      category,
      message,
      details: sanitizedDetails,
      traceId: this.currentTraceId || undefined,
    };

    if (level === 'error' || level === 'fatal') {
      if (details instanceof Error) {
        entry.stack = details.stack;
        entry.message = `${message}: ${details.message}`;
      }
    }

    this.logs.push(entry);
    this.trimLogs();

    // Notify listeners
    this.listeners.forEach((listener) => {
      try {
        listener(entry);
      } catch (e) {
        console.error('Log listener error:', e);
      }
    });

    // Also output to console
    this.consoleLog(entry);

    // Persist warn/error/fatal to main process file
    if (level === 'warn' || level === 'error' || level === 'fatal') {
      this.queueForPersistence(entry);
    }
  }

  private queueForPersistence(entry: LogEntry): void {
    // electron-log doesn't support 'fatal', map to 'error'
    const persistLevel = entry.level === 'fatal' ? 'error' : entry.level;

    this.pendingLogs.push({
      level: persistLevel as 'debug' | 'info' | 'warn' | 'error',
      category: entry.category,
      message: entry.message,
      timestamp: entry.timestamp,
      details: entry.details,
    });

    if (this.pendingLogs.length >= this.FLUSH_THRESHOLD) {
      this.flushToFile();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushToFile();
    }, this.FLUSH_INTERVAL);
  }

  private async flushToFile(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingLogs.length === 0) return;

    const logsToWrite = [...this.pendingLogs];
    this.pendingLogs = [];

    try {
      await api.log.write(logsToWrite);
    } catch {
      // Ignore write errors to avoid infinite recursion
    }
  }

  async flush(): Promise<void> {
    await this.flushToFile();
  }

  debug(category: string, message: string, details?: unknown): void {
    this.log('debug', category, message, details);
  }

  info(category: string, message: string, details?: unknown): void {
    this.log('info', category, message, details);
  }

  warn(category: string, message: string, details?: unknown): void {
    this.log('warn', category, message, details);
  }

  error(category: string, message: string, details?: unknown): void {
    this.log('error', category, message, details);
  }

  fatal(category: string, message: string, details?: unknown): void {
    this.log('fatal', category, message, details);
  }

  getLogs(filter?: LogFilter): LogEntry[] {
    let result = [...this.logs];

    if (filter) {
      if (filter.level) {
        const minPriority = this.levelPriority[filter.level];
        result = result.filter((log) => this.levelPriority[log.level] >= minPriority);
      }

      if (filter.category) {
        result = result.filter((log) => log.category === filter.category);
      }

      if (filter.startTime) {
        result = result.filter((log) => log.timestamp >= filter.startTime!);
      }

      if (filter.endTime) {
        result = result.filter((log) => log.timestamp <= filter.endTime!);
      }

      if (filter.search) {
        const searchLower = filter.search.toLowerCase();
        result = result.filter(
          (log) =>
            log.message.toLowerCase().includes(searchLower) ||
            log.category.toLowerCase().includes(searchLower)
        );
      }

      if (filter.regex) {
        result = result.filter(
          (log) => filter.regex!.test(log.message) || filter.regex!.test(log.category)
        );
      }

      if (filter.traceId) {
        result = result.filter((log) => log.traceId === filter.traceId);
      }
    }

    return result;
  }

  clear(): void {
    this.logs = [];
  }

  addListener(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  export(): string {
    return this.logs
      .map((log) => {
        const time = new Date(log.timestamp).toISOString();
        const details = log.details ? ` | ${JSON.stringify(log.details)}` : '';
        const stack = log.stack ? `\n${log.stack}` : '';
        const traceId = log.traceId ? ` [${log.traceId}]` : '';
        return `[${time}] [${log.level.toUpperCase()}] [${log.category}]${traceId} ${log.message}${details}${stack}`;
      })
      .join('\n');
  }

  exportAsJSON(filter?: LogFilter): string {
    const logs = filter ? this.getLogs(filter) : this.logs;
    return JSON.stringify(logs, null, 2);
  }

  exportDiagnosticReport(): string {
    const stats = this.getErrorStats();
    const recentErrors = this.getLogs({ level: 'error' }).slice(-10);
    const categories = [...new Set(this.logs.map((l) => l.category))];

    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalLogs: stats.total,
        errors: stats.errors,
        warnings: stats.warnings,
        categories: categories.length,
      },
      environment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'N/A',
        language: typeof navigator !== 'undefined' ? navigator.language : 'N/A',
      },
      recentErrors: recentErrors.map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        category: e.category,
        message: e.message,
        stack: e.stack,
      })),
      logsByCategory: categories.map((cat) => ({
        category: cat,
        count: this.logs.filter((l) => l.category === cat).length,
        errors: this.logs.filter(
          (l) => l.category === cat && (l.level === 'error' || l.level === 'fatal')
        ).length,
      })),
    };

    return JSON.stringify(report, null, 2);
  }

  getErrorStats(): { errors: number; warnings: number; total: number } {
    const errors = this.logs.filter((log) => log.level === 'error' || log.level === 'fatal').length;
    const warnings = this.logs.filter((log) => log.level === 'warn').length;
    return { errors, warnings, total: this.logs.length };
  }

  private trimLogs(): void {
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  private consoleLog(entry: LogEntry): void {
    const prefix = `[${entry.category}]`;
    const args = entry.details ? [prefix, entry.message, entry.details] : [prefix, entry.message];

    switch (entry.level) {
      case 'debug':
        console.debug(...args);
        break;
      case 'info':
        console.info(...args);
        break;
      case 'warn':
        console.warn(...args);
        break;
      case 'error':
      case 'fatal':
        console.error(...args);
        if (entry.stack) {
          console.error(entry.stack);
        }
        break;
    }
  }
}

// ====== Singleton & Factory ======

export const LogService = new LogServiceImpl();

/** Create a logger scoped to a specific category */
export function createLogger(category: string) {
  return {
    debug: (message: string, details?: unknown) => LogService.debug(category, message, details),
    info: (message: string, details?: unknown) => LogService.info(category, message, details),
    warn: (message: string, details?: unknown) => LogService.warn(category, message, details),
    error: (message: string, details?: unknown) => LogService.error(category, message, details),
    fatal: (message: string, details?: unknown) => LogService.fatal(category, message, details),
    startTimer: (name: string) => LogService.startTimer(`${category}:${name}`),
    endTimer: (name: string) => LogService.endTimer(`${category}:${name}`),
    logWithDuration: (level: LogLevel, message: string, timerName: string, details?: unknown) =>
      LogService.logWithDuration(level, category, message, `${category}:${timerName}`, details),
    setTraceId: (traceId: string | null) => LogService.setTraceId(traceId),
    generateTraceId: () => LogService.generateTraceId(),
  };
}

// ====== Global Error Handlers ======

export function setupGlobalErrorHandlers(): void {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    // Monaco Editor cancellation is normal behavior, not an error
    if (reason?.name === 'Canceled' || reason?.message === 'Canceled') {
      event.preventDefault();
      return;
    }
    // AbortError from fetch cancellation
    if (reason?.name === 'AbortError') {
      event.preventDefault();
      return;
    }

    LogService.error('Global', 'Unhandled Promise Rejection', event.reason);
  });

  window.addEventListener('error', (event) => {
    // ResizeObserver loop warnings are harmless browser behavior
    if (event.message?.includes('ResizeObserver loop')) {
      return;
    }

    LogService.error('Global', 'Uncaught Error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    });
  });

  LogService.info('Global', 'Global error handlers initialized');
}
