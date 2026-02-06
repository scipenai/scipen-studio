/**
 * @file TraceService - Cross-process trace collection
 * @description Tracks spans across IPC boundaries for performance analysis
 * @depends IpcChannel, shared/trace
 */

import { IpcChannel } from '@shared/ipc/channels';
import {
  type SpanContext,
  type SpanData,
  type SpanEvent,
  createChildContext,
  generateId,
} from '@shared/trace';
import { createLogger } from './LoggerService';

const logger = createLogger('TraceService');

// ====== Trace Service Implementation ======
class TraceServiceImpl {
  private static instance: TraceServiceImpl;

  /** Active spans keyed by spanId for fast lookup. */
  private spans: Map<string, SpanData> = new Map();

  /** Completed traces grouped by traceId. */
  private completedTraces: Map<string, SpanData[]> = new Map();

  /** Upper bound to prevent unbounded trace memory growth. */
  private readonly maxCompletedTraces = 100;

  /** Guard to avoid duplicate IPC handler registration. */
  private ipcRegistered = false;

  private constructor() {
    this.registerIpcHandlers();
  }

  public static getInstance(): TraceServiceImpl {
    if (!TraceServiceImpl.instance) {
      TraceServiceImpl.instance = new TraceServiceImpl();
    }
    return TraceServiceImpl.instance;
  }

  // ====== IPC Integration ======

  /** @sideeffect Binds ipcMain handlers when running in the browser process */
  private registerIpcHandlers(): void {
    if (this.ipcRegistered) return;

    // Avoid registering in utility processes.
    if ((process as NodeJS.Process & { type?: string }).type !== 'browser') {
      logger.debug('Skipping IPC handler registration (not in main process)');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ipcMain } = require('electron');

      // Expose startSpan to renderer processes.
      ipcMain.handle(
        IpcChannel.Trace_Start,
        (_event: unknown, name: string, parentContext?: SpanContext) => {
          return this.startSpan(name, parentContext);
        }
      );

      // Expose endSpan to renderer processes.
      ipcMain.handle(
        IpcChannel.Trace_End,
        (
          _event: unknown,
          spanId: string,
          result?: { error?: string; attributes?: Record<string, unknown> }
        ) => {
          this.endSpan(spanId, result);
        }
      );

      // Expose trace retrieval to renderer processes.
      ipcMain.handle(IpcChannel.Trace_Get, (_event: unknown, traceId: string) => {
        return this.getTrace(traceId);
      });

      this.ipcRegistered = true;
      logger.info('IPC handlers registered');
    } catch (error) {
      logger.warn('Failed to register IPC handlers:', error);
    }
  }

  // ====== Span Lifecycle ======

  /** @sideeffect Stores the span in the active span registry */
  public startSpan(name: string, parentContext?: SpanContext): SpanContext {
    const context: SpanContext = parentContext
      ? createChildContext(parentContext)
      : {
          traceId: generateId(),
          spanId: generateId(),
        };

    const span: SpanData = {
      context,
      name,
      startTime: Date.now(),
      status: 'running',
      events: [],
    };

    this.spans.set(context.spanId, span);

    logger.debug(`Span started: ${name}`, {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
    });

    return context;
  }

  /** @sideeffect Removes from active map and appends to completed trace list */
  public endSpan(
    spanId: string,
    result?: { error?: string; attributes?: Record<string, unknown> }
  ): void {
    const span = this.spans.get(spanId);

    if (!span) {
      logger.warn(`Span not found: ${spanId}`);
      return;
    }

    const endTime = Date.now();
    span.endTime = endTime;
    span.duration = endTime - span.startTime;
    span.status = result?.error ? 'error' : 'completed';

    if (result?.error) {
      span.error = result.error;
    }

    if (result?.attributes) {
      span.attributes = { ...span.attributes, ...result.attributes };
    }

    // Remove from active spans.
    this.spans.delete(spanId);

    // Append to completed trace storage.
    this.addToCompletedTrace(span);

    logger.debug(`Span ended: ${span.name}`, {
      spanId,
      duration: span.duration,
      status: span.status,
    });
  }

  /** @sideeffect Mutates span event list */
  public addSpanEvent(
    spanId: string,
    eventName: string,
    attributes?: Record<string, unknown>
  ): void {
    const span = this.spans.get(spanId);

    if (!span) {
      logger.warn(`Cannot add event, span not found: ${spanId}`);
      return;
    }

    const event: SpanEvent = {
      name: eventName,
      timestamp: Date.now(),
      attributes,
    };

    span.events = span.events || [];
    span.events.push(event);
  }

  /** @sideeffect Mutates span attribute map */
  public setSpanAttribute(spanId: string, key: string, value: unknown): void {
    const span = this.spans.get(spanId);

    if (!span) {
      return;
    }

    span.attributes = span.attributes || {};
    span.attributes[key] = value;
  }

  // ====== Trace Access ======

  public getTrace(traceId: string): SpanData[] {
    const completedSpans = this.completedTraces.get(traceId) || [];

    // Include spans still running.
    const runningSpans: SpanData[] = [];
    for (const span of this.spans.values()) {
      if (span.context.traceId === traceId) {
        runningSpans.push(span);
      }
    }

    return [...completedSpans, ...runningSpans];
  }

  public getActiveSpanCount(): number {
    return this.spans.size;
  }

  /** @sideeffect May trigger cleanup of old traces */
  private addToCompletedTrace(span: SpanData): void {
    const traceId = span.context.traceId;

    if (!this.completedTraces.has(traceId)) {
      this.completedTraces.set(traceId, []);
    }

    this.completedTraces.get(traceId)!.push(span);

    // Enforce trace retention limits.
    this.cleanupOldTraces();
  }

  private cleanupOldTraces(): void {
    if (this.completedTraces.size <= this.maxCompletedTraces) {
      return;
    }

    // Evict oldest traces first.
    const sortedTraces = Array.from(this.completedTraces.entries())
      .map(([traceId, spans]) => ({
        traceId,
        oldestTime: Math.min(...spans.map((s) => s.startTime)),
      }))
      .sort((a, b) => a.oldestTime - b.oldestTime);

    const deleteCount = this.completedTraces.size - this.maxCompletedTraces;
    for (let i = 0; i < deleteCount; i++) {
      this.completedTraces.delete(sortedTraces[i].traceId);
    }
  }

  // ====== Utilities ======

  /** @throws Rethrows from wrapped operation */
  public async traced<T>(
    name: string,
    operation: (context: SpanContext) => Promise<T>,
    parentContext?: SpanContext
  ): Promise<T> {
    const context = this.startSpan(name, parentContext);

    try {
      const result = await operation(context);
      this.endSpan(context.spanId);
      return result;
    } catch (error) {
      this.endSpan(context.spanId, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public clear(): void {
    this.spans.clear();
    this.completedTraces.clear();
    logger.info('All trace data cleared');
  }
}

// ====== Exports ======

// Shared singleton instance.
export const TraceService = TraceServiceImpl.getInstance();

// Export class for tests.
export { TraceServiceImpl };

/** @throws Rethrows from wrapped operation */
export function traced<T>(
  name: string,
  operation: (context: SpanContext) => Promise<T>,
  parentContext?: SpanContext
): Promise<T> {
  return TraceService.traced(name, operation, parentContext);
}
