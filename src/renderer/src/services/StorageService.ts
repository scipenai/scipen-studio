/**
 * @file StorageService.ts - Persistent Storage Service
 * @description Manages local storage of UI state, similar to VS Code's Memento pattern
 * @depends localStorage
 */

import { Emitter, type IDisposable } from '../../../../shared/utils';

export interface IStorageService {
  get<T>(key: string, defaultValue?: T): T | undefined;
  getBoolean(key: string, defaultValue?: boolean): boolean;
  getNumber(key: string, defaultValue?: number): number;
  getString(key: string, defaultValue?: string): string;
  getObject<T>(key: string, defaultValue?: T): T | undefined;

  store<T>(key: string, value: T): void;
  remove(key: string): void;

  onDidChangeStorage<T>(key: string, callback: (newValue: T | undefined) => void): void;
}

export class StorageService implements IStorageService, IDisposable {
  private _onDidChangeStorage = new Emitter<{ key: string; value: unknown }>();

  // In-memory cache to reduce localStorage I/O operations
  private _cache = new Map<string, unknown>();

  constructor() {
    // Load all data from localStorage into cache on initialization
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('scipen.')) {
          const value = localStorage.getItem(key);
          if (value) {
            try {
              this._cache.set(key, JSON.parse(value));
            } catch {
              this._cache.set(key, value);
            }
          }
        }
      }
    } catch (e) {
      console.warn('StorageService: Failed to access localStorage', e);
    }
  }

  private _getKey(key: string): string {
    return `scipen.${key}`;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    const fullKey = this._getKey(key);
    return this._cache.has(fullKey) ? (this._cache.get(fullKey) as T) : defaultValue;
  }

  getBoolean(key: string, defaultValue = false): boolean {
    const value = this.get<boolean | string>(key, defaultValue);
    return value === true || value === 'true';
  }

  getNumber(key: string, defaultValue = 0): number {
    const value = this.get(key, defaultValue);
    return Number(value) || defaultValue;
  }

  getString(key: string, defaultValue = ''): string {
    const value = this.get(key, defaultValue);
    return String(value);
  }

  getObject<T>(key: string, defaultValue?: T): T | undefined {
    return this.get<T>(key, defaultValue);
  }

  store<T>(key: string, value: T): void {
    const fullKey = this._getKey(key);

    // Skip update if value hasn't changed to avoid unnecessary events
    if (this._cache.get(fullKey) === value) {
      return;
    }

    this._cache.set(fullKey, value);

    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (e) {
      console.warn('StorageService: Write failed', e);
    }

    this._onDidChangeStorage.fire({ key, value });
  }

  remove(key: string): void {
    const fullKey = this._getKey(key);
    this._cache.delete(fullKey);
    localStorage.removeItem(fullKey);
    this._onDidChangeStorage.fire({ key: key, value: undefined });
  }

  onDidChangeStorage<T>(key: string, callback: (newValue: T | undefined) => void): void {
    this._onDidChangeStorage.event((e) => {
      if (e.key === key) {
        callback(e.value as T | undefined);
      }
    });
  }

  dispose(): void {
    this._onDidChangeStorage.dispose();
    this._cache.clear();
  }
}

// ============ Lazy Service Access ============

let _storageService: StorageService | null = null;

/**
 * Get StorageService instance (lazy initialization)
 */
export function getStorageService(): StorageService {
  if (!_storageService) {
    const { getServices } = require('./core/ServiceRegistry');
    _storageService = getServices().storage;
  }
  return _storageService!;
}

/**
 * Set StorageService instance (called by ServiceRegistry)
 * @internal
 */
export function _setStorageServiceInstance(instance: StorageService): void {
  _storageService = instance;
}
