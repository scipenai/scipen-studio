/**
 * Preload API Type Declarations
 * 
 * Provides complete type hints for renderer process
 */

import type { ElectronAPI } from './index';

export type { ElectronAPI };

/**
 * Extends Window interface to include electron API
 */
declare global {
  interface Window {
    /**
     * Electron API exposed to renderer process
     * Safely exposed via contextBridge
     */
    electron: ElectronAPI;
  }
}

/**
 * Trace context type
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/**
 * Log source type
 */
export interface LogSource {
  process: 'main' | 'renderer';
  window?: string;
  module?: string;
}

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

