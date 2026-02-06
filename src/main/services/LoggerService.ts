/**
 * @file LoggerService - Unified logging service
 * @description Centralized logging with module context, log rotation, and performance monitoring.
 * @supports Main process, renderer process (via IPC), and utility process
 * @security Automatically redacts sensitive data (API keys, tokens, passwords, cookies)
 */

import path from 'path';
import { IpcChannel } from '@shared/ipc/channels';
import log from 'electron-log';
import fs from './knowledge/utils/fsCompat';

// ====== Types ======

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Log source information */
export interface LogSource {
  process: 'main' | 'renderer';
  window?: string;
  module?: string;
  context?: Record<string, unknown>;
}

export interface LogEntry {
  level: LogLevel;
  source: LogSource;
  module: string;
  message: string;
  data?: unknown;
  timestamp: Date;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  time(label: string): void;
  timeEnd(label: string): void;
}

export interface MemoryUsage {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

// ANSI color codes for console output
const ANSI = {
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  UNDERLINE: '\x1b[4m',
};

function colorText(text: string, color: keyof typeof ANSI): string {
  return ANSI[color] + text + ANSI.RESET;
}

// ====== Sensitive Data Redaction ======

/**
 * Sensitive field name patterns (case-insensitive).
 * Fields matching these patterns will have their values redacted.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /^api[_-]?key$/i,
  /^apikey$/i,
  /^secret[_-]?key$/i,
  /^secretkey$/i,
  /^password$/i,
  /^passwd$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^bearer$/i,
  /^credential/i,
  /^private[_-]?key$/i,
  /^secret$/i,
  /^key$/i,
  /^auth$/i,
  // Cookie related
  /^cookie[s]?$/i,
  /^session[_-]?id$/i,
  /^csrf[_-]?token$/i,
  /^x[_-]?csrf[_-]?token$/i,
  /^overleaf[_-]?cookie[s]?$/i,
];

/**
 * Sensitive value patterns for string content detection.
 * Matches API keys, tokens, and other secrets embedded in strings.
 */
const SENSITIVE_VALUE_PATTERNS = [
  // OpenAI API Keys (sk-proj-..., sk-...)
  { pattern: /(sk-[a-zA-Z0-9]{2,})[a-zA-Z0-9-_]{10,}/g, replacement: '$1***REDACTED***' },
  // Anthropic API Keys (sk-ant-...)
  { pattern: /(sk-ant-[a-zA-Z0-9]{2,})[a-zA-Z0-9-_]{10,}/g, replacement: '$1***REDACTED***' },
  // Generic Bearer tokens
  { pattern: /(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, replacement: '$1***REDACTED***' },
  // AWS Access Keys (AKIA...)
  { pattern: /(AKIA[A-Z0-9]{2})[A-Z0-9]{14}/g, replacement: '$1***REDACTED***' },
  // Generic long hex strings (likely keys, 32+ chars)
  { pattern: /([a-f0-9]{8})[a-f0-9]{24,}/gi, replacement: '$1***REDACTED***' },
  // JWT Tokens (xxx.xxx.xxx format)
  {
    pattern: /(eyJ[a-zA-Z0-9_-]{10,})\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    replacement: '$1.***REDACTED***',
  },
  // Email addresses (partial redaction for privacy)
  {
    pattern: /([a-zA-Z0-9._%+-]{1,3})[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+)/g,
    replacement: '$1***@$2',
  },
  // Overleaf session cookies
  {
    pattern: /(overleaf[_-]?session\d*=)[a-zA-Z0-9%._-]{10,}/gi,
    replacement: '$1***REDACTED***',
  },
  {
    pattern: /(gke[_-]?route=)[a-zA-Z0-9%._-]{10,}/gi,
    replacement: '$1***REDACTED***',
  },
  // Generic session ID pattern
  {
    pattern: /(session[_-]?id=)[a-zA-Z0-9%._-]{10,}/gi,
    replacement: '$1***REDACTED***',
  },
  // Cookie header values (long strings)
  {
    pattern: /(Cookie:\s*)[a-zA-Z0-9=;%._\s-]{50,}/gi,
    replacement: '$1***REDACTED***',
  },
];

/** Check if a field name matches sensitive patterns */
function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/** Redact sensitive patterns from a string value */
function redactStringValue(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_VALUE_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Recursively redact sensitive information from data.
 * @param data - Data to redact
 * @param depth - Current recursion depth (prevents infinite recursion)
 */
function redactSensitiveData(data: unknown, depth = 0): unknown {
  // Prevent infinite recursion on circular references
  if (depth > 10) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (data === null || data === undefined) {
    return data;
  }

  // String: detect and redact sensitive patterns
  if (typeof data === 'string') {
    return redactStringValue(data);
  }

  // Primitives: pass through
  if (typeof data !== 'object') {
    return data;
  }

  // Array: recurse into elements
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1));
  }

  // Object: check field names and recurse
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveFieldName(key)) {
      if (typeof value === 'string' && value.length > 0) {
        // Keep first 3 chars for debugging, redact the rest
        const prefix = value.substring(0, Math.min(3, value.length));
        result[key] = `${prefix}***REDACTED***`;
      } else {
        result[key] = '***REDACTED***';
      }
    } else {
      result[key] = redactSensitiveData(value, depth + 1);
    }
  }

  return result;
}

// ====== Logger Implementation ======

class LoggerServiceImpl {
  private static instance: LoggerServiceImpl;
  private logBuffer: LogEntry[] = [];
  private readonly maxBufferSize = 1000;
  private timers: Map<string, number> = new Map();
  private memoryMonitorInterval: NodeJS.Timeout | null = null;
  private logsDir = '';
  private ipcRegistered = false;

  private constructor() {
    this.initializeTransports();
    this.registerIpcHandler();
  }

  public static getInstance(): LoggerServiceImpl {
    if (!LoggerServiceImpl.instance) {
      LoggerServiceImpl.instance = new LoggerServiceImpl();
    }
    return LoggerServiceImpl.instance;
  }

  private initializeTransports(): void {
    // Log directory depends on process type:
    // - Utility Process: from LOGS_DIR env var
    // - Main Process: from app.getPath('userData')
    if (process.type === 'utility') {
      this.logsDir = process.env.LOGS_DIR || '';
      // Disable file logging if no path is injected
      if (!this.logsDir) {
        log.transports.file.level = false;
      }
    } else {
      // Main process - use dynamic import to avoid loading electron in utility process
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron');
        this.logsDir = path.join(app.getPath('userData'), 'logs');
      } catch (error) {
        console.error('Failed to get userData path:', error);
        this.logsDir = '';
        log.transports.file.level = false;
      }
    }

    // Ensure logs directory exists
    if (this.logsDir) {
      try {
        fs.ensureDirSync(this.logsDir);
      } catch (e) {
        console.error('Failed to create logs dir:', e);
        log.transports.file.level = false;
      }
    }

    // File transport configuration
    log.transports.file.level = 'info';
    log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

    // Console transport
    log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

    // Error logging to separate file
    log.transports.file.resolvePathFn = (variables) => {
      // Utility process logs to separate file to avoid locking
      const baseName = process.type === 'utility' ? 'lsp-process.log' : 'main.log';
      const fileName = variables.fileName || baseName;
      return path.join(this.logsDir, fileName);
    };

    log.info(`[LoggerService] Initialized in ${process.type || 'unknown'} process`);
  }

  /**
   * Register IPC handler to receive logs from renderer process.
   * @remarks Only registered in main process; utility process does not handle renderer logs
   */
  private registerIpcHandler(): void {
    if (this.ipcRegistered) return;

    // Only register IPC handlers in the main process
    if (process.type !== 'browser') {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ipcMain } = require('electron');
      ipcMain.handle(
        IpcChannel.Log_FromRenderer,
        (
          _event: unknown,
          source: LogSource,
          level: LogLevel,
          message: string,
          data?: unknown[]
        ) => {
          this.processRendererLog(source, level, message, data);
        }
      );
      this.ipcRegistered = true;
    } catch (error) {
      console.error('Failed to register IPC handler:', error);
    }
  }

  /** Process logs forwarded from renderer process */
  private processRendererLog(
    source: LogSource,
    level: LogLevel,
    message: string,
    data?: unknown[]
  ): void {
    const timestamp = new Date();
    const moduleStr = source.module || 'Renderer';
    const windowStr = source.window ? `${source.window}::` : '';

    // Redact sensitive data before logging
    const redactedMessage = redactStringValue(message);
    const redactedData = data ? data.map((d) => redactSensitiveData(d)) : undefined;

    const formattedMessage = `[${windowStr}${moduleStr}] ${redactedMessage}`;

    this.addToBuffer({
      level,
      source,
      module: moduleStr,
      message: redactedMessage,
      data: redactedData?.[0],
      timestamp,
    });

    // Development: colorized console output
    if (process.env.NODE_ENV === 'development') {
      const pad = (n: number, len = 2) => String(n).padStart(len, '0');
      const ms = timestamp.getMilliseconds();
      const timeStr = colorText(
        `${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}.${pad(ms, 3)}`,
        'CYAN'
      );

      const sourceStr = ` [${colorText(windowStr + moduleStr, 'UNDERLINE')}] `;

      switch (level) {
        case 'error':
          console.error(
            `${timeStr} ${colorText('<ERROR>', 'RED')}${sourceStr}${redactedMessage}`,
            ...(redactedData || [])
          );
          break;
        case 'warn':
          console.warn(
            `${timeStr} ${colorText('<WARN>', 'YELLOW')}${sourceStr}${redactedMessage}`,
            ...(redactedData || [])
          );
          break;
        case 'info':
          console.info(
            `${timeStr} ${colorText('<INFO>', 'GREEN')}${sourceStr}${redactedMessage}`,
            ...(redactedData || [])
          );
          break;
        case 'debug':
          console.debug(
            `${timeStr} ${colorText('<DEBUG>', 'BLUE')}${sourceStr}${redactedMessage}`,
            ...(redactedData || [])
          );
          break;
      }
    }

    // Write to log file
    const logData =
      redactedData && redactedData.length > 0
        ? [formattedMessage, ...redactedData]
        : [formattedMessage];

    switch (level) {
      case 'debug':
        log.debug(...logData);
        break;
      case 'info':
        log.info(...logData);
        break;
      case 'warn':
        log.warn(...logData);
        break;
      case 'error':
        log.error(...logData);
        break;
    }
  }

  /**
   * Create a logger with module context
   */
  public withContext(moduleName: string): Logger {
    const self = this;

    return {
      debug(message: string, data?: unknown) {
        self.log('debug', moduleName, message, data);
      },
      info(message: string, data?: unknown) {
        self.log('info', moduleName, message, data);
      },
      warn(message: string, data?: unknown) {
        self.log('warn', moduleName, message, data);
      },
      error(message: string, data?: unknown) {
        self.log('error', moduleName, message, data);
      },
      time(label: string) {
        self.time(`${moduleName}:${label}`);
      },
      timeEnd(label: string) {
        self.timeEnd(`${moduleName}:${label}`);
      },
    };
  }

  private log(level: LogLevel, module: string, message: string, data?: unknown): void {
    const timestamp = new Date();

    // Redact sensitive data
    const redactedMessage = redactStringValue(message);
    const redactedData = data !== undefined ? redactSensitiveData(data) : undefined;

    const formattedMessage = `[${module}] ${redactedMessage}`;

    this.addToBuffer({
      level,
      source: { process: 'main', module },
      module,
      message: redactedMessage,
      data: redactedData,
      timestamp,
    });

    const logData =
      redactedData !== undefined ? [formattedMessage, redactedData] : [formattedMessage];

    switch (level) {
      case 'debug':
        log.debug(...logData);
        break;
      case 'info':
        log.info(...logData);
        break;
      case 'warn':
        log.warn(...logData);
        break;
      case 'error':
        log.error(...logData);
        break;
    }
  }

  private addToBuffer(entry: LogEntry): void {
    this.logBuffer.push(entry);

    // Trim buffer if too large
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
    }
  }

  /**
   * Start a timer
   */
  public time(label: string): void {
    this.timers.set(label, performance.now());
  }

  /**
   * End a timer and log the duration
   */
  public timeEnd(label: string): void {
    const start = this.timers.get(label);
    if (start !== undefined) {
      const duration = performance.now() - start;
      this.log('debug', 'Performance', `${label}: ${duration.toFixed(2)}ms`);
      this.timers.delete(label);
    }
  }

  /**
   * Get current memory usage
   */
  public getMemoryUsage(): MemoryUsage {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
      externalMB: Math.round((usage.external / 1024 / 1024) * 100) / 100,
    };
  }

  /**
   * Start memory monitoring at interval
   */
  public startMemoryMonitoring(intervalMs = 60000): void {
    if (this.memoryMonitorInterval) {
      return;
    }

    const logger = this.withContext('MemoryMonitor');

    this.memoryMonitorInterval = setInterval(() => {
      const usage = this.getMemoryUsage();
      logger.info('Memory usage', usage);

      // Warn if heap usage is high
      if (usage.heapUsedMB > 500) {
        logger.warn('High memory usage detected', usage);
      }
    }, intervalMs);

    logger.info('Memory monitoring started', { intervalMs });
  }

  /**
   * Stop memory monitoring
   */
  public stopMemoryMonitoring(): void {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
      this.log('info', 'MemoryMonitor', 'Memory monitoring stopped');
    }
  }

  /**
   * Get recent log entries
   */
  public getRecentLogs(count = 100, level?: LogLevel): LogEntry[] {
    let entries = this.logBuffer;

    if (level) {
      entries = entries.filter((e) => e.level === level);
    }

    return entries.slice(-count);
  }

  /**
   * Get logs directory path
   */
  public getLogsDir(): string {
    return this.logsDir;
  }

  /**
   * Get log file path
   */
  public getLogFilePath(): string {
    const logFile = log.transports.file.getFile();
    return logFile?.path || '';
  }

  /**
   * Clear log buffer
   */
  public clearBuffer(): void {
    this.logBuffer = [];
  }

  /**
   * Export logs to file
   */
  public async exportLogs(targetPath: string): Promise<void> {
    const logFile = log.transports.file.getFile();
    if (logFile?.path) {
      await fs.copy(logFile.path, targetPath);
    }
  }

  /** Cleanup on app exit */
  public finish(): void {
    this.stopMemoryMonitoring();
    log.info('[LoggerService] Finished');
  }
}

// ====== Exports ======

export const LoggerService = LoggerServiceImpl.getInstance();

/** Create a logger instance with module context */
export function createLogger(moduleName: string): Logger {
  return LoggerService.withContext(moduleName);
}
