/**
 * @file Shared Utility Library - Entry Point
 * @description Unified exports for utilities shared between Main and Renderer processes
 * @depends lifecycle, event, cancellation, async, result
 */

// ====== Lifecycle Management ======

export {
  type IDisposable,
  Disposable,
  DisposableStore,
  MutableDisposable,
  isDisposable,
  toDisposable,
  combinedDisposable,
} from './lifecycle';

// ====== Event System ======

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
} from './event';

// ====== Cancellation ======

export {
  CancellationTokenSource,
  CancellationError,
  CancellationToken,
  isCancellationError,
} from './cancellation';

// ====== Async Utilities ======

export {
  type ICancellableTask,
  type ITask,
  Throttler,
  Sequencer,
  SequencerByKey,
  Delayer,
  RunOnceScheduler,
  IdleValue,
  SimpleThrottle,
  SimpleDelayer,
  timeout,
  nextAnimationFrame,
  nextIdleFrame,
  retry,
  safeRequestIdleCallback,
  safeCancelIdleCallback,
} from './async';

// ====== Result Type ======

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
} from './result';
