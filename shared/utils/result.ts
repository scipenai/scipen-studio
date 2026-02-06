/**
 * @file Result Type - Error Handling Without Exceptions
 * @description Rust-inspired Result<T, E> type for predictable error handling
 * @depends None (pure type definitions and utility functions)
 *
 * @example
 * async function compile(content: string): Promise<Result<PDFData, CompileError>> {
 *   if (!compiler) {
 *     return err({ code: 'NO_COMPILER', message: 'Compiler not found' });
 *   }
 *   const pdf = await compiler.run(content);
 *   return ok(pdf);
 * }
 *
 * const result = await compile(content);
 * if (result.ok) {
 *   showPdf(result.value);
 * } else {
 *   showError(result.error.message);
 * }
 */

// ====== Core Type Definitions ======

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

// ====== Constructors ======

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

// ====== Type Guards ======

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

// ====== Utility Functions ======

export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * Extract value from Result, throws if error
 * @throws {Error} When result is an error
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.ok) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Convert Promise<T> to Promise<Result<T, Error>>
 */
export async function tryCatch<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Wrap a throwing function to return Result
 */
export function resultify<T, Args extends unknown[]>(
  fn: (...args: Args) => T
): (...args: Args) => Result<T, Error> {
  return (...args: Args): Result<T, Error> => {
    try {
      return ok(fn(...args));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

// ====== Common Error Types ======

export interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function operationError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): OperationError {
  return { code, message, details };
}

export interface CompileError {
  code: 'NO_COMPILER' | 'COMPILE_FAILED' | 'TIMEOUT' | 'INVALID_INPUT';
  message: string;
  errors?: string[];
  warnings?: string[];
  log?: string;
}

export interface AIError {
  code: 'NO_API_KEY' | 'RATE_LIMIT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'UNKNOWN';
  message: string;
  retryable: boolean;
}
