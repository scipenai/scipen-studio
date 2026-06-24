/**
 * @file JSON-RPC 2.0 envelope + NDJSON framing helpers
 * @description Mirror of `snaca-editor-protocol::jsonrpc` + `::codec`.
 *   Pure functions, no IO — caller pipes them onto a child process stdio
 *   stream.
 */

import { z } from 'zod';

export const JsonRpcRequestIdSchema = z.union([z.number(), z.string(), z.null()]);
export type JsonRpcRequestId = z.infer<typeof JsonRpcRequestIdSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcRequestIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcRequestIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .refine((v) => (v.result === undefined) !== (v.error === undefined), {
    message: 'response must have exactly one of {result, error}',
  });
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

/**
 * Discriminate between the three message shapes based on which fields are
 * present. Order matters: requests carry both `id` and `method`, responses
 * carry `id` without `method`, notifications carry `method` without `id`.
 */
export function classifyMessage(
  obj: Record<string, unknown>
): { kind: 'request' } | { kind: 'response' } | { kind: 'notification' } | { kind: 'invalid' } {
  if (typeof obj !== 'object' || obj === null) return { kind: 'invalid' };
  if (obj.jsonrpc !== '2.0') return { kind: 'invalid' };
  const hasId = 'id' in obj;
  const hasMethod = typeof obj.method === 'string';
  if (hasId && hasMethod) return { kind: 'request' };
  if (hasId && !hasMethod) return { kind: 'response' };
  if (!hasId && hasMethod) return { kind: 'notification' };
  return { kind: 'invalid' };
}

// --------- NDJSON framing ---------

/** Default max frame size mirroring Rust side. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Encode any value as a single NDJSON line (one `\n` terminator).
 * Result is a string; caller writes it to the child's stdin.
 */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Stateful line buffer for stdin chunks coming off a child stdout. Emits
 * complete lines (without the `\n` terminator). Whitespace-only lines are
 * silently dropped.
 *
 * Single instance per stream; not thread-safe (Node main process is
 * single-threaded anyway).
 */
export class LineBuffer {
  private buffer = '';
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /**
   * Feeds new bytes; returns 0+ complete lines as strings.
   * @throws Error if any single accumulated line exceeds `maxFrameBytes`.
   */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        if (trimmed.length > this.maxFrameBytes) {
          throw new Error(
            `frame payload ${trimmed.length} bytes exceeds max ${this.maxFrameBytes}`
          );
        }
        lines.push(trimmed);
      }
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error(
        `pending frame buffer ${this.buffer.length} bytes exceeds max ${this.maxFrameBytes}`
      );
    }
    return lines;
  }

  /** Reset accumulator (e.g. after a process restart). */
  reset(): void {
    this.buffer = '';
  }
}

/** Best-effort parse of one NDJSON line into a JSON value. */
export function parseLine(line: string): unknown {
  return JSON.parse(line);
}
