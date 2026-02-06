/**
 * @file index.ts - Renderer process utility library unified exports
 * @description Centralizes exports of renderer process utility functions, including VS Code-style shared utilities
 * @depends shared/utils, hooks, fileValidation, fileNaming
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ============ VS Code-style Utilities (from shared) ============

// Lifecycle management
export {
  type IDisposable,
  Disposable,
  DisposableStore,
  MutableDisposable,
  isDisposable,
  toDisposable,
  combinedDisposable,
} from '../../../../shared/utils/lifecycle';

// Event system
export {
  type EventHandler,
  type IEvent,
  type EmitterOptions,
  type DebounceOptions,
  MicrotaskDelay,
  Emitter,
  EventBuffer,
  EventCoalescer,
  Relay,
  Event,
  debounceEvent,
} from '../../../../shared/utils/event';

// Cancellation
export {
  CancellationToken,
  CancellationTokenSource,
  CancellationError,
  isCancellationError,
} from '../../../../shared/utils/cancellation';

// Async utilities
export {
  type ICancellableTask,
  type ITask,
  Throttler,
  Sequencer,
  SequencerByKey,
  Delayer,
  RunOnceScheduler,
  IdleValue,
  timeout,
  nextAnimationFrame,
  nextIdleFrame,
  retry,
} from '../../../../shared/utils/async';

// Result type
export {
  type Ok,
  type Err,
  type Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  mapErr,
  tryCatch,
  resultify,
  type OperationError,
  type CompileError,
  type AIError,
  operationError,
} from '../../../../shared/utils/result';

// ============ React Hooks (from hooks directory) ============

export {
  // Async hooks
  useDelayer,
  useThrottler,
  useIdleCallback,
  useDebounce,
  // Disposable hooks
  useDisposables,
  useDisposable,
  useMutableDisposable,
  // Event hooks
  useEvent,
  useEventValue,
  useDebouncedEvent,
  useEventBuffer,
  useEmitter,
  // Service hooks
  useServiceRegistry,
  useEditorService,
  useAIService,
  useProjectService,
  useUIService,
  useSettingsService,
  useWorkingCopyService,
  useBackupService,
  useCompileService,
  useCommandService,
  useKeybindingService,
  useViewRegistry,
  useStorageService,
  useServiceState,
} from '../hooks';

// ============ File Utilities ============

// File name validation (VS Code-style)
export {
  type ValidationResult,
  validateFileName,
  validateFilePath,
  isValidFileName,
  getWellFormedFileName,
  trimFileName,
} from './fileValidation';

// Smart file naming (VS Code-style incremental naming)
export {
  type IncrementalNamingMode,
  incrementFileName,
  findAvailableFileName,
  findAvailableFileNames,
} from './fileNaming';

// ============ UI Utilities ============

/**
 * Merge Tailwind CSS classes with clsx
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

import { getLocale, t } from '../locales';

/**
 * Format date with locale support
 * Uses app's current locale setting
 */
export function formatDate(date: Date | number | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const locale = getLocale();
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format time ago with locale support
 * Supports Date object, timestamp number, or ISO 8601 string
 */
export function formatTimeAgo(date: Date | number | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (seconds < 60) return t('welcome.justNow');
  if (seconds < 3600) return t('welcome.minAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('welcome.hoursAgo', { count: Math.floor(seconds / 3600) });
  if (seconds < 604800) return t('welcome.daysAgo', { count: Math.floor(seconds / 86400) });
  return formatDate(d);
}

/**
 * Format time for chat sessions with locale support
 */
export function formatChatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const locale = getLocale();

  if (days === 0) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return t('welcome.yesterday');
  } else if (days < 7) {
    return t('welcome.daysAgo', { count: days });
  } else {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
}

/**
 * Generate unique ID
 */
export function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Get file extension
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

/**
 * Get language for file
 */
export function getLanguageForFile(filename: string): string {
  const ext = getFileExtension(filename);
  const languageMap: Record<string, string> = {
    tex: 'latex',
    latex: 'latex',
    ltx: 'latex',
    sty: 'latex',
    cls: 'latex',
    bib: 'bibtex',
    typ: 'typst',
    md: 'markdown',
    json: 'json',
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    txt: 'plaintext',
  };
  return languageMap[ext] || 'plaintext';
}

/**
 * Escape HTML
 */
export function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
}

/**
 * Truncate text
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
  const w = window as unknown as { electron?: { ipcRenderer?: unknown } };
  return typeof window !== 'undefined' && !!w.electron?.ipcRenderer;
}

/**
 * Get platform
 */
export function getPlatform(): 'mac' | 'windows' | 'linux' | 'unknown' {
  if (!isElectron()) return 'unknown';
  const w = window as unknown as { electron?: { platform?: string } };
  const platform = w.electron?.platform;
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

/**
 * Get modifier key based on platform
 */
export function getModifierKey(): string {
  return getPlatform() === 'mac' ? '⌘' : 'Ctrl';
}
