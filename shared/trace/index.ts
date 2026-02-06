/**
 * @file Request Tracing Utilities
 * @description Cross-process request tracing and performance analysis
 * @depends None (pure utility functions)
 */

export interface SpanContext {
  /** Trace ID - shared across the entire request chain */
  traceId: string;
  /** Span ID - unique identifier for current operation */
  spanId: string;
  parentSpanId?: string;
}

export interface SpanData {
  context: SpanContext;
  name: string;
  /** Start time (Unix timestamp ms) */
  startTime: number;
  endTime?: number;
  /** Duration (ms) */
  duration?: number;
  status: 'running' | 'completed' | 'error';
  error?: string;
  attributes?: Record<string, unknown>;
  events?: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function createTraceContext(): SpanContext {
  const traceId = generateId();
  const spanId = generateId();

  return {
    traceId,
    spanId,
  };
}

export function createChildContext(parent: SpanContext): SpanContext {
  return {
    traceId: parent.traceId,
    spanId: generateId(),
    parentSpanId: parent.spanId,
  };
}

/**
 * Extract trace context from IPC arguments
 */
export function extractTraceContext(args: unknown[]): SpanContext | undefined {
  if (!args || args.length === 0) return undefined;

  const lastArg = args[args.length - 1];

  if (
    typeof lastArg === 'object' &&
    lastArg !== null &&
    'type' in lastArg &&
    (lastArg as { type: string }).type === 'trace' &&
    'context' in lastArg
  ) {
    return (lastArg as { context: SpanContext }).context;
  }

  return undefined;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1) {
    return `${(durationMs * 1000).toFixed(2)}μs`;
  }
  if (durationMs < 1000) {
    return `${durationMs.toFixed(2)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}
