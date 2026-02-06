/**
 * @file Lifecycle Management
 * @description Uniformly manages lifecycle of event listeners, timers, and other resources
 * @depends None (base dependency for other utilities)
 *
 * Borrowed from VS Code's Disposable pattern.
 */

/**
 * Disposable resource interface
 */
export interface IDisposable {
  dispose(): void;
}

/**
 * Check if an object is disposable
 */
export function isDisposable(obj: unknown): obj is IDisposable {
  return (
    typeof obj === 'object' && obj !== null && typeof (obj as IDisposable).dispose === 'function'
  );
}

/**
 * Convert a function to a Disposable
 */
export function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn };
}

/**
 * Combine multiple Disposables into one
 * Disposes all items even if some throw errors
 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  return {
    dispose() {
      const errors: unknown[] = [];
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) {
        console.error('[combinedDisposable] Errors during dispose:', errors);
      }
    },
  };
}

/**
 * Disposable storage container
 * Used to uniformly manage the lifecycle of multiple Disposables
 */
export class DisposableStore implements IDisposable {
  private _isDisposed = false;
  private _toDispose = new Set<IDisposable>();

  /**
   * Whether it has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Add a Disposable
   */
  add<T extends IDisposable>(disposable: T): T {
    if (this._isDisposed) {
      console.warn('[DisposableStore] Adding to disposed store, disposing immediately');
      disposable.dispose();
      return disposable;
    }
    this._toDispose.add(disposable);
    return disposable;
  }

  /**
   * Delete a Disposable (without disposing)
   */
  delete(disposable: IDisposable): void {
    this._toDispose.delete(disposable);
  }

  /**
   * Delete and dispose a Disposable
   * Throws if dispose() fails
   */
  deleteAndDispose(disposable: IDisposable): void {
    this._toDispose.delete(disposable);
    try {
      disposable.dispose();
    } catch (e) {
      console.error('[DisposableStore] Error during deleteAndDispose:', e);
      throw e;
    }
  }

  /**
   * Clear all Disposables (disposing them)
   *
   * Fault-tolerant: If a dispose() call throws, the error is logged
   * and disposal continues for remaining items. This prevents a single
   * failing disposable from leaking other resources.
   */
  clear(): void {
    const errors: unknown[] = [];
    for (const d of this._toDispose) {
      try {
        d.dispose();
      } catch (e) {
        errors.push(e);
      }
    }
    this._toDispose.clear();

    // Report all errors after cleanup is complete
    if (errors.length > 0) {
      console.error(`[DisposableStore] ${errors.length} error(s) during dispose:`, errors);
    }
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.clear();
  }
}

/**
 * Abstract base class Disposable
 * Convenient for class inheritance, provides _register method
 */
export abstract class Disposable implements IDisposable {
  static None = Object.freeze<IDisposable>({ dispose() {} });

  protected readonly _store = new DisposableStore();

  public dispose(): void {
    this._store.dispose();
  }

  protected _register<T extends IDisposable>(t: T): T {
    if ((t as unknown) === this) {
      throw new Error('Cannot register a disposable on itself!');
    }
    return this._store.add(t);
  }
}

/**
 * Mutable Disposable container
 * Automatically disposes old value when setting a new one
 */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  private _value?: T;
  private _isDisposed = false;

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value;
  }

  set value(value: T | undefined) {
    if (this._isDisposed) {
      value?.dispose();
      return;
    }
    if (this._value !== value) {
      this._value?.dispose();
      this._value = value;
    }
  }

  dispose(): void {
    this._isDisposed = true;
    this._value?.dispose();
    this._value = undefined;
  }
}
