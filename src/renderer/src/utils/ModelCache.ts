/**
 * @file ModelCache.ts - Monaco text model cache management
 * @description LRU cache for Monaco Editor TextModels using WeakRef to allow GC reclamation.
 *              Prevents memory leaks while preserving view state across tab switches.
 * @depends monaco-editor, shared/utils
 */

import type * as monaco from 'monaco-editor';
import type { IDisposable } from '../../../../shared/utils';

// ====== Types ======

interface CachedEntry {
  /** WeakRef allows GC to reclaim model if memory pressure */
  modelRef: WeakRef<monaco.editor.ITextModel>;
  viewState: monaco.editor.ICodeEditorViewState | null;
  lastAccess: number;
  language: string;
}

// ====== ModelCache Implementation ======

export class ModelCache implements IDisposable {
  private readonly _cache = new Map<string, CachedEntry>();
  private readonly _maxSize: number;
  private _disposed = false;

  /**
   * @param maxSize Maximum cached models before LRU eviction
   */
  constructor(maxSize = 20) {
    this._maxSize = maxSize;
  }

  /**
   * Gets cached model and viewState, or null if not cached or GC'd.
   */
  get(path: string): {
    model: monaco.editor.ITextModel;
    viewState: monaco.editor.ICodeEditorViewState | null;
  } | null {
    if (this._disposed) return null;

    const cached = this._cache.get(path);
    if (!cached) return null;

    const model = cached.modelRef.deref();
    if (!model || model.isDisposed()) {
      this._cache.delete(path);
      return null;
    }

    cached.lastAccess = Date.now();

    return { model, viewState: cached.viewState };
  }

  /**
   * Caches a model with its viewState.
   */
  set(
    path: string,
    model: monaco.editor.ITextModel,
    viewState: monaco.editor.ICodeEditorViewState | null,
    language: string
  ): void {
    if (this._disposed) return;

    // LRU eviction if at capacity
    if (!this._cache.has(path) && this._cache.size >= this._maxSize) {
      this._evictOldest();
    }

    this._cache.set(path, {
      modelRef: new WeakRef(model),
      viewState,
      lastAccess: Date.now(),
      language,
    });
  }

  /**
   * Updates viewState without creating new model.
   */
  updateViewState(path: string, viewState: monaco.editor.ICodeEditorViewState | null): void {
    if (this._disposed) return;

    const cached = this._cache.get(path);
    if (cached) {
      cached.viewState = viewState;
      cached.lastAccess = Date.now();
    }
  }

  /**
   * Checks if path has valid cached model.
   */
  has(path: string): boolean {
    if (this._disposed) return false;

    const cached = this._cache.get(path);
    if (!cached) return false;

    const model = cached.modelRef.deref();
    if (!model || model.isDisposed()) {
      this._cache.delete(path);
      return false;
    }

    return true;
  }

  /**
   * Deletes cached model and disposes it.
   */
  delete(path: string): void {
    if (this._disposed) return;

    const cached = this._cache.get(path);
    if (cached) {
      const model = cached.modelRef.deref();
      if (model && !model.isDisposed()) {
        model.dispose();
      }
      this._cache.delete(path);
    }
  }

  /**
   * Removes and disposes models not in openPaths set.
   */
  cleanup(openPaths: Set<string>): void {
    if (this._disposed) return;

    for (const [path, cached] of this._cache) {
      if (!openPaths.has(path)) {
        const model = cached.modelRef.deref();
        if (model && !model.isDisposed()) {
          model.dispose();
        }
        this._cache.delete(path);
      }
    }
  }

  get size(): number {
    return this._cache.size;
  }

  /**
   * Evicts least recently used entry.
   */
  private _evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [path, cached] of this._cache) {
      if (cached.lastAccess < oldestTime) {
        oldestTime = cached.lastAccess;
        oldest = path;
      }
    }

    if (oldest) {
      const cached = this._cache.get(oldest);
      if (cached) {
        const model = cached.modelRef.deref();
        if (model && !model.isDisposed()) {
          model.dispose();
        }
        this._cache.delete(oldest);
        console.log(`[ModelCache] Evicted oldest: ${oldest}`);
      }
    }
  }

  /**
   * Disposes all cached models and clears cache.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    for (const [, cached] of this._cache) {
      const model = cached.modelRef.deref();
      if (model && !model.isDisposed()) {
        model.dispose();
      }
    }
    this._cache.clear();

    console.log('[ModelCache] Disposed');
  }
}

// ====== Global Singleton ======

let Instance: ModelCache | null = null;

/**
 * Gets the global ModelCache singleton instance.
 */
export function getModelCache(): ModelCache {
  if (!Instance) {
    Instance = new ModelCache(20);
  }
  return Instance;
}

/**
 * Resets the global ModelCache (for testing or app restart).
 */
export function resetModelCache(): void {
  if (Instance) {
    Instance.dispose();
    Instance = null;
  }
}
