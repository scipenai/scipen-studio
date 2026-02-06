/**
 * @file Cancellation Token
 * @description Gracefully cancel async operations (compilation, AI requests, network calls)
 * @depends event, lifecycle
 *
 * Borrowed from VS Code's CancellationToken implementation (src/vs/base/common/cancellation.ts).
 */

import { Emitter, type IEvent } from './event';
import type { IDisposable } from './lifecycle';

// ====== Cancellation Token Interface ======

/**
 * Cancellation Token interface
 */
export interface CancellationToken {
  /**
   * Whether cancellation has been requested
   */
  readonly isCancellationRequested: boolean;

  /**
   * Cancellation request event
   */
  readonly onCancellationRequested: IEvent<void>;
}

// ====== Singleton Tokens ======

/**
 * Empty implementation: never cancelled
 */
const neverCancelledToken: CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
});

/**
 * Empty implementation: already cancelled
 */
const cancelledToken: CancellationToken = Object.freeze({
  isCancellationRequested: true,
  onCancellationRequested: () => ({ dispose: () => {} }),
});

// ====== CancellationToken Namespace ======

export namespace CancellationToken {
  /**
   * Token that is never cancelled
   */
  export const None: CancellationToken = neverCancelledToken;

  /**
   * Token that is already cancelled
   */
  export const Cancelled: CancellationToken = cancelledToken;

  /**
   * Check if something is a CancellationToken
   */
  export function isCancellationToken(thing: unknown): thing is CancellationToken {
    if (thing === CancellationToken.None || thing === CancellationToken.Cancelled) {
      return true;
    }
    if (!thing || typeof thing !== 'object') {
      return false;
    }
    return (
      typeof (thing as CancellationToken).isCancellationRequested === 'boolean' &&
      typeof (thing as CancellationToken).onCancellationRequested === 'function'
    );
  }
}

// ====== MutableToken Implementation ======

/**
 * Mutable cancellation token implementation
 */
class MutableToken implements CancellationToken {
  private _isCancelled = false;
  private _emitter: Emitter<void> | null = null;

  get isCancellationRequested(): boolean {
    return this._isCancelled;
  }

  get onCancellationRequested(): IEvent<void> {
    if (!this._emitter) {
      this._emitter = new Emitter<void>();
    }
    return this._emitter.event;
  }

  cancel(): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    if (this._emitter) {
      this._emitter.fire(undefined);
      this._emitter.dispose();
      this._emitter = null;
    }
  }

  dispose(): void {
    if (this._emitter) {
      this._emitter.dispose();
      this._emitter = null;
    }
  }
}

// ====== CancellationTokenSource ======

/**
 * Cancellation Token Source
 *
 * Used to create and control CancellationToken.
 *
 * @example
 * ```typescript
 * const source = new CancellationTokenSource();
 *
 * async function fetchData(token: CancellationToken) {
 *   const response = await fetch('/api/data');
 *   if (token.isCancellationRequested) {
 *     throw new CancellationError();
 *   }
 *   return response.json();
 * }
 *
 * // Start request
 * const promise = fetchData(source.token);
 *
 * // User clicks cancel
 * source.cancel();
 * source.dispose();
 * ```
 */
export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken;
  private _parentListener?: IDisposable;

  /**
   * Create CancellationTokenSource
   * @param parent Parent token, if parent is cancelled, child will be cancelled too
   */
  constructor(parent?: CancellationToken) {
    if (parent) {
      this._parentListener = parent.onCancellationRequested(this.cancel, this);
    }
  }

  /**
   * Get CancellationToken
   */
  get token(): CancellationToken {
    if (!this._token) {
      this._token = new MutableToken();
    }
    return this._token;
  }

  /**
   * Request cancellation
   */
  cancel(): void {
    if (this._token instanceof MutableToken) {
      this._token.cancel();
    } else if (!this._token) {
      // If token hasn't been requested yet, use the already cancelled singleton
      this._token = CancellationToken.Cancelled;
    }
  }

  /**
   * Dispose resources
   */
  dispose(cancel = false): void {
    if (cancel) {
      this.cancel();
    }
    this._parentListener?.dispose();
    if (this._token instanceof MutableToken) {
      this._token.dispose();
    }
  }
}

// ====== CancellationError ======

/**
 * Cancellation Error
 */
export class CancellationError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

// ====== Utility Functions ======

/**
 * Check if an error is a CancellationError
 */
export function isCancellationError(error: unknown): error is CancellationError {
  return (
    error instanceof CancellationError ||
    (error instanceof Error && error.name === 'CancellationError')
  );
}
