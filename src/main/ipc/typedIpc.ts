/**
 * Type-Safe IPC Handler Registration
 *
 * Provides type-safe IPC handler registration, ensuring:
 * 1. Channel names must be defined in IPCApiContract
 * 2. Handler parameter types are automatically inferred
 * 3. Return value types are automatically validated
 * 4. Runtime parameter validation (optional, using zod schema)
 *
 * @example
 * // Type-safe handler registration
 * registerTypedHandler(IpcChannel.Compile_LaTeX, async (content, options) => {
 *   // content: string, options: LaTeXCompileOptions | undefined (auto-inferred)
 *   return result; // Must match LaTeXCompileResult type
 * });
 *
 * // Batch registration
 * const handlers = createTypedHandlers({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => { ... },
 *   [IpcChannel.Compile_Typst]: async (content, options) => { ... },
 * });
 * handlers.registerAll();
 */

import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { z } from 'zod';
import type { IPCArgs, IPCInvokeChannel, IPCResult } from '../../../shared/api-types';
import { channelSchemas } from './ipcSchemas';

// Re-export channelSchemas so existing consumers (e.g. chatHandlers) can still import from here
export { channelSchemas } from './ipcSchemas';

// ==================== Validation Errors ====================

/**
 * Error thrown when IPC parameter validation fails
 */
export class IPCValidationError extends Error {
  constructor(
    public readonly channel: string,
    public readonly validationErrors: z.ZodError
  ) {
    super(`Invalid arguments for IPC channel '${channel}': ${validationErrors.message}`);
    this.name = 'IPCValidationError';
  }
}

// ==================== Type Definitions ====================

/**
 * IPC handler function type
 * Receives channel parameters, returns channel result
 */
export type IPCHandler<T extends IPCInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IPCArgs<T>
) => Promise<IPCResult<T>> | IPCResult<T>;

/**
 * Handler type without event parameter (more concise API)
 */
export type IPCHandlerWithoutEvent<T extends IPCInvokeChannel> = (
  ...args: IPCArgs<T>
) => Promise<IPCResult<T>> | IPCResult<T>;

/**
 * Handler registration options
 */
export interface HandlerOptions {
  /** Whether to log errors when handler fails */
  logErrors?: boolean;
  /** Custom error handling */
  onError?: (channel: string, error: unknown) => void;
  /**
   * Custom validation schema for this handler
   * Overrides the schema in channelSchemas if provided
   */
  schema?: z.ZodSchema;
  /**
   * Skip runtime validation even if a schema exists
   * @default false
   */
  skipValidation?: boolean;
}

// ==================== Core Functions ====================

/**
 * Register type-safe IPC handler
 *
 * @param channel - IPC channel (must be defined in IPCApiContract)
 * @param handler - Handler function
 * @param options - Optional configuration
 *
 * @example
 * registerTypedHandler(IpcChannel.Compile_LaTeX, async (event, content, options) => {
 *   const result = await compileLatex(content, options);
 *   return result;
 * });
 *
 * // With custom validation schema
 * registerTypedHandler(IpcChannel.Custom_Channel, handler, {
 *   schema: z.tuple([z.string(), z.number()]),
 * });
 */
export function registerTypedHandler<T extends IPCInvokeChannel>(
  channel: T,
  handler: IPCHandler<T>,
  options?: HandlerOptions
): void {
  const { logErrors = true, onError, schema, skipValidation = false } = options ?? {};

  // Determine which schema to use: explicit > registry > none
  const validationSchema = schema ?? (skipValidation ? undefined : channelSchemas.get(channel));

  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      // Runtime parameter validation (if schema is defined)
      if (validationSchema) {
        const validationResult = validationSchema.safeParse(args);
        if (!validationResult.success) {
          const validationError = new IPCValidationError(channel, validationResult.error);
          console.error(
            `[IPC] Validation failed for '${channel}':`,
            validationResult.error.format()
          );
          throw validationError;
        }
      }

      // Execute handler with validated arguments
      return await handler(event, ...(args as IPCArgs<T>));
    } catch (error) {
      if (logErrors) {
        console.error(`[IPC] Error in handler '${channel}':`, error);
      }
      if (onError) {
        onError(channel, error);
      }
      throw error;
    }
  });
}

/**
 * Register type-safe IPC handler (version without event parameter)
 *
 * Most handlers don't need the event parameter, this version is more concise
 *
 * @example
 * registerHandler(IpcChannel.Compile_LaTeX, async (content, options) => {
 *   return await compileLatex(content, options);
 * });
 */
export function registerHandler<T extends IPCInvokeChannel>(
  channel: T,
  handler: IPCHandlerWithoutEvent<T>,
  options?: HandlerOptions
): void {
  registerTypedHandler(channel, (_event, ...args) => handler(...args), options);
}

// ==================== Batch Registration ====================

/**
 * Handler map type
 */
export type HandlersMap = {
  [K in IPCInvokeChannel]?: IPCHandlerWithoutEvent<K>;
};

/**
 * Create type-safe handler collection
 *
 * @example
 * const handlers = createTypedHandlers({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => {
 *     return await compileLatex(content, options);
 *   },
 *   [IpcChannel.Compile_Typst]: async (content, options) => {
 *     return await compileTypst(content, options);
 *   },
 * });
 *
 * // Register all handlers
 * handlers.registerAll();
 *
 * // Or register individually
 * handlers.register(IpcChannel.Compile_LaTeX);
 */
export function createTypedHandlers<T extends HandlersMap>(
  handlers: T,
  options?: HandlerOptions
): {
  /** Register all handlers */
  registerAll: () => void;
  /** Register single handler */
  register: <K extends keyof T & IPCInvokeChannel>(channel: K) => void;
  /** Get list of registered channels */
  channels: (keyof T)[];
} {
  const channels = Object.keys(handlers) as (keyof T)[];

  return {
    registerAll: () => {
      for (const channel of channels) {
        const handler = handlers[channel];
        if (handler) {
          registerHandler(
            channel as IPCInvokeChannel,
            handler as IPCHandlerWithoutEvent<IPCInvokeChannel>,
            options
          );
        }
      }
    },
    register: <K extends keyof T & IPCInvokeChannel>(channel: K) => {
      const handler = handlers[channel];
      if (handler) {
        registerHandler(channel, handler as IPCHandlerWithoutEvent<K>, options);
      }
    },
    channels,
  };
}

// ==================== Unregistration ====================

/**
 * Unregister IPC handler
 */
export function unregisterHandler(channel: IPCInvokeChannel): void {
  ipcMain.removeHandler(channel);
}

/**
 * Unregister multiple handlers
 */
export function unregisterHandlers(channels: IPCInvokeChannel[]): void {
  for (const channel of channels) {
    unregisterHandler(channel);
  }
}

// ==================== Factory Functions ====================

/**
 * Create handler factory with dependency injection
 *
 * @example
 * interface CompileDeps {
 *   latexCompiler: LaTeXCompiler;
 *   typstCompiler: TypstCompiler;
 * }
 *
 * const createCompileHandlers = createHandlerFactory<CompileDeps>((deps) => ({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => {
 *     return await deps.latexCompiler.compile(content, options);
 *   },
 *   [IpcChannel.Compile_Typst]: async (content, options) => {
 *     return await deps.typstCompiler.compile(content, options);
 *   },
 * }));
 *
 * // Usage
 * const handlers = createCompileHandlers({ latexCompiler, typstCompiler });
 * handlers.registerAll();
 */
export function createHandlerFactory<TDeps>(
  factory: (deps: TDeps) => HandlersMap
): (deps: TDeps, options?: HandlerOptions) => ReturnType<typeof createTypedHandlers> {
  return (deps: TDeps, options?: HandlerOptions) => {
    const handlers = factory(deps);
    return createTypedHandlers(handlers, options);
  };
}
