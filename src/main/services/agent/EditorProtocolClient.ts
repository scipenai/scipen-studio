/**
 * @file EditorProtocolClient
 * @description JSON-RPC 2.0 client over the snaca-editor sidecar's NDJSON
 *   stdio. Owns:
 *
 *   - Outbound request encoding + id allocation
 *   - Inbound dispatch (responses correlated by id; notifications fanned
 *     to typed events; SNACA-side `context.request` routed to a handler)
 *   - Runtime Zod validation of every inbound payload — bad shapes log a
 *     warning and are dropped, never crash the client
 *   - Pending-request cleanup when the sidecar disconnects (all in-flight
 *     promises reject)
 *
 *   Method semantics mirror the spec one-to-one; long-running operations
 *   resolve with the synchronous response (turn_id) and the actual streamed
 *   work arrives via `on*` events.
 *
 * @see docs/editor-protocol.md
 */

import { Emitter, type Event } from '../../../../shared/utils/event';
import { Disposable, type IDisposable } from '../../../../shared/utils/lifecycle';
import type {
  ClientConnectionState,
  ContextRequestHandler,
  IEditorProtocolClient,
} from './interfaces/IEditorProtocolClient';
import type { ISnacaSidecarService } from './interfaces/ISnacaSidecarService';
import {
  classifyMessage,
  encodeLine,
  parseLine,
  type JsonRpcError as WireJsonRpcError,
  type JsonRpcRequestId,
} from './protocol/envelope';
import { EditorErrorCode, EditorProtocolError } from './protocol/errors';
import { HostToSnaca, SnacaToHost } from './protocol/methods';
import {
  ChatSendResultSchema,
  ComposerStartResultSchema,
  ConfigReloadResultSchema,
  ContextRequestParamsSchema,
  EditConfirmResultSchema,
  EditProposeCompleteParamsSchema,
  EditProposeDeltaParamsSchema,
  EditProposeParamsSchema,
  ErrorNotificationParamsSchema,
  HealthPingResultSchema,
  InitResultSchema,
  InlineEditStartResultSchema,
  LogWriteParamsSchema,
  MemoryDeleteResultSchema,
  MemoryGetResultSchema,
  MemoryListResultSchema,
  MemoryRevealResultSchema,
  MemoryUpdatedParamsSchema,
  MemoryWriteResultSchema,
  PlanConfirmResultSchema,
  PlanUpdateParamsSchema,
  SessionDeleteThreadResultSchema,
  SessionGetMessagesResultSchema,
  SessionListThreadsResultSchema,
  SessionNewThreadResultSchema,
  SessionOpenResultSchema,
  SessionSwitchThreadResultSchema,
  ShutdownResultSchema,
  SkillsGetResultSchema,
  SkillsListResultSchema,
  SkillsReloadResultSchema,
  ToolApprovalRequestParamsSchema,
  TurnDeltaParamsSchema,
  UsageUpdateParamsSchema,
  type ChatSendParams,
  type ChatSendResult,
  type ComposerStartParams,
  type ComposerStartResult,
  type ConfigReloadResult,
  type ContextRequestParams,
  type ContextRespondParams,
  type EditConfirmParams,
  type EditConfirmResult,
  type EditProposeCompleteParams,
  type EditProposeDeltaParams,
  type EditProposeParams,
  type ErrorNotificationParams,
  type HealthPingResult,
  type InitParams,
  type InitResult,
  type InlineEditStartParams,
  type InlineEditStartResult,
  type LogWriteParams,
  type MemoryDeleteParams,
  type MemoryDeleteResult,
  type MemoryGetParams,
  type MemoryGetResult,
  type MemoryListParams,
  type MemoryListResult,
  type MemoryRevealParams,
  type MemoryRevealResult,
  type MemoryUpdatedParams,
  type MemoryWriteParams,
  type MemoryWriteResult,
  type PlanConfirmParams,
  type PlanConfirmResult,
  type PlanUpdateParams,
  type SessionDeleteThreadResult,
  type SessionGetMessagesResult,
  type SessionListThreadsResult,
  type SessionNewThreadResult,
  type SessionOpenParams,
  type SessionOpenResult,
  type SessionSwitchThreadResult,
  type SkillsGetParams,
  type SkillsGetResult,
  type SkillsListParams,
  type SkillsListResult,
  type SkillsReloadParams,
  type SkillsReloadResult,
  type SnacaConfig,
  type ToolApprovalRequestParams,
  type ToolConfirmParams,
  type TurnCancelParams,
  type TurnDeltaParams,
  type UsageUpdateParams,
} from './protocol/schemas';
import { createLogger } from '../LoggerService';
import { z, type ZodType } from 'zod';

const logger = createLogger('EditorProtocolClient');

/** How long an outstanding RPC may wait before rejecting. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** A few methods legitimately stream for minutes; opt them out of the cap. */
const NO_TIMEOUT_METHODS = new Set<string>([
  HostToSnaca.ChatSend,
  HostToSnaca.InlineEditStart,
  HostToSnaca.ComposerStart,
]);

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class EditorProtocolClient extends Disposable implements IEditorProtocolClient {
  // ---------- inbound notification emitters ----------
  private readonly _onStateChange = this._register(new Emitter<ClientConnectionState>());
  private readonly _onTurnDelta = this._register(new Emitter<TurnDeltaParams>());
  private readonly _onEditPropose = this._register(new Emitter<EditProposeParams>());
  private readonly _onEditProposeDelta = this._register(new Emitter<EditProposeDeltaParams>());
  private readonly _onEditProposeComplete = this._register(new Emitter<EditProposeCompleteParams>());
  private readonly _onPlanUpdate = this._register(new Emitter<PlanUpdateParams>());
  private readonly _onToolApprovalRequest = this._register(new Emitter<ToolApprovalRequestParams>());
  private readonly _onUsageUpdate = this._register(new Emitter<UsageUpdateParams>());
  private readonly _onMemoryUpdated = this._register(new Emitter<MemoryUpdatedParams>());
  private readonly _onError = this._register(new Emitter<ErrorNotificationParams>());
  private readonly _onLog = this._register(new Emitter<LogWriteParams>());

  readonly onStateChange: Event<ClientConnectionState> = this._onStateChange.event;
  readonly onTurnDelta = this._onTurnDelta.event;
  readonly onEditPropose = this._onEditPropose.event;
  readonly onEditProposeDelta = this._onEditProposeDelta.event;
  readonly onEditProposeComplete = this._onEditProposeComplete.event;
  readonly onPlanUpdate = this._onPlanUpdate.event;
  readonly onToolApprovalRequest = this._onToolApprovalRequest.event;
  readonly onUsageUpdate = this._onUsageUpdate.event;
  readonly onMemoryUpdated = this._onMemoryUpdated.event;
  readonly onError = this._onError.event;
  readonly onLog = this._onLog.event;

  // ---------- mutable state ----------
  private _state: ClientConnectionState = { kind: 'disconnected' };
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private contextRequestHandler: ContextRequestHandler | null = null;

  constructor(private readonly sidecar: ISnacaSidecarService) {
    super();
    this._register(sidecar.onStdoutLine((line) => this.handleInboundLine(line)));
    this._register(
      sidecar.onStateChange((s) => {
        if (s.kind === 'stopped' || s.kind === 'crashed') {
          // Connection severed; reject pending requests and reset state.
          this.failAllPending(`sidecar ${s.kind}`);
          if (this._state.kind !== 'disconnected') {
            this.setState({ kind: 'disconnected' });
          }
        }
      })
    );
  }

  get state(): ClientConnectionState {
    return this._state;
  }

  // ============= public protocol methods =============

  async init(params: InitParams): Promise<InitResult> {
    this.setState({ kind: 'connecting' });
    try {
      const result = await this.request(HostToSnaca.Init, params, InitResultSchema);
      this.setState({
        kind: 'connected',
        engineVersion: result.engine_version,
        protocolVersion: result.protocol_version,
      });
      return result;
    } catch (e) {
      this.setState({ kind: 'disconnected' });
      throw e;
    }
  }

  async shutdown(): Promise<{ ok: boolean }> {
    return this.request(HostToSnaca.Shutdown, {}, ShutdownResultSchema);
  }

  async healthPing(): Promise<HealthPingResult> {
    return this.request(HostToSnaca.HealthPing, {}, HealthPingResultSchema);
  }

  async configReload(snacaConfig: SnacaConfig): Promise<ConfigReloadResult> {
    return this.request(
      HostToSnaca.ConfigReload,
      { snaca_config: snacaConfig },
      ConfigReloadResultSchema
    );
  }

  // ----- session -----

  async sessionOpen(params: SessionOpenParams): Promise<SessionOpenResult> {
    return this.request(HostToSnaca.SessionOpen, params, SessionOpenResultSchema);
  }

  async sessionClose(sessionId: string): Promise<{ closed: boolean }> {
    return this.request(
      HostToSnaca.SessionClose,
      { session_id: sessionId },
      // Inline schema rather than top-level export — tiny, single use.
      // Validated as { closed: boolean }.
      anonymousSchema<{ closed: boolean }>()
    );
  }

  async sessionListThreads(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SessionListThreadsResult> {
    return this.request(
      HostToSnaca.SessionListThreads,
      { session_id: sessionId, ...opts },
      SessionListThreadsResultSchema
    );
  }

  async sessionNewThread(sessionId: string, title?: string): Promise<SessionNewThreadResult> {
    return this.request(
      HostToSnaca.SessionNewThread,
      { session_id: sessionId, title },
      SessionNewThreadResultSchema
    );
  }

  async sessionSwitchThread(
    sessionId: string,
    threadId: string
  ): Promise<SessionSwitchThreadResult> {
    return this.request(
      HostToSnaca.SessionSwitchThread,
      { session_id: sessionId, thread_id: threadId },
      SessionSwitchThreadResultSchema
    );
  }

  async sessionDeleteThread(
    sessionId: string,
    threadId: string
  ): Promise<SessionDeleteThreadResult> {
    return this.request(
      HostToSnaca.SessionDeleteThread,
      { session_id: sessionId, thread_id: threadId },
      SessionDeleteThreadResultSchema
    );
  }

  async sessionRenameThread(
    sessionId: string,
    threadId: string,
    title: string
  ): Promise<{ renamed: boolean }> {
    return this.request(
      HostToSnaca.SessionRenameThread,
      { session_id: sessionId, thread_id: threadId, title },
      anonymousSchema<{ renamed: boolean }>()
    );
  }

  async sessionGetMessages(
    sessionId: string,
    threadId: string,
    limit?: number
  ): Promise<SessionGetMessagesResult> {
    return this.request(
      HostToSnaca.SessionGetMessages,
      { session_id: sessionId, thread_id: threadId, limit },
      SessionGetMessagesResultSchema
    );
  }

  // ----- agent surfaces -----

  async chatSend(params: ChatSendParams): Promise<ChatSendResult> {
    return this.request(HostToSnaca.ChatSend, params, ChatSendResultSchema);
  }

  async inlineEditStart(params: InlineEditStartParams): Promise<InlineEditStartResult> {
    return this.request(HostToSnaca.InlineEditStart, params, InlineEditStartResultSchema);
  }

  async composerStart(params: ComposerStartParams): Promise<ComposerStartResult> {
    return this.request(HostToSnaca.ComposerStart, params, ComposerStartResultSchema);
  }

  async planConfirm(params: PlanConfirmParams): Promise<PlanConfirmResult> {
    return this.request(HostToSnaca.PlanConfirm, params, PlanConfirmResultSchema);
  }

  // ----- control -----

  async turnCancel(params: TurnCancelParams): Promise<void> {
    await this.notify(HostToSnaca.TurnCancel, params);
  }

  async editConfirm(params: EditConfirmParams): Promise<EditConfirmResult> {
    return this.request(HostToSnaca.EditConfirm, params, EditConfirmResultSchema);
  }

  async toolConfirm(params: ToolConfirmParams): Promise<{ ok: boolean }> {
    return this.request(HostToSnaca.ToolConfirm, params, anonymousSchema<{ ok: boolean }>());
  }

  // ----- memory viewer -----

  async memoryList(params: MemoryListParams): Promise<MemoryListResult> {
    return this.request(HostToSnaca.MemoryList, params, MemoryListResultSchema);
  }

  async memoryGet(params: MemoryGetParams): Promise<MemoryGetResult> {
    return this.request(HostToSnaca.MemoryGet, params, MemoryGetResultSchema);
  }

  async memoryWrite(params: MemoryWriteParams): Promise<MemoryWriteResult> {
    return this.request(HostToSnaca.MemoryWrite, params, MemoryWriteResultSchema);
  }

  async memoryDelete(params: MemoryDeleteParams): Promise<MemoryDeleteResult> {
    return this.request(HostToSnaca.MemoryDelete, params, MemoryDeleteResultSchema);
  }

  async memoryReveal(params: MemoryRevealParams): Promise<MemoryRevealResult> {
    return this.request(HostToSnaca.MemoryReveal, params, MemoryRevealResultSchema);
  }

  // ----- skills viewer -----

  async skillsList(params: SkillsListParams): Promise<SkillsListResult> {
    return this.request(HostToSnaca.SkillsList, params, SkillsListResultSchema);
  }

  async skillsGet(params: SkillsGetParams): Promise<SkillsGetResult> {
    return this.request(HostToSnaca.SkillsGet, params, SkillsGetResultSchema);
  }

  async skillsReload(params: SkillsReloadParams): Promise<SkillsReloadResult> {
    return this.request(HostToSnaca.SkillsReload, params, SkillsReloadResultSchema);
  }

  // ----- reverse RPC -----

  setContextRequestHandler(handler: ContextRequestHandler): IDisposable {
    this.contextRequestHandler = handler;
    return {
      dispose: () => {
        if (this.contextRequestHandler === handler) {
          this.contextRequestHandler = null;
        }
      },
    };
  }

  // ============= override dispose =============

  override dispose(): void {
    this.failAllPending('client disposed');
    super.dispose();
  }

  // ============= internals =============

  private setState(next: ClientConnectionState): void {
    this._state = next;
    this._onStateChange.fire(next);
  }

  private allocateId(): string {
    const id = `host-req-${this.nextRequestId++}`;
    return id;
  }

  private async request<T>(method: string, params: unknown, resultSchema: ZodType<T>): Promise<T> {
    const id = this.allocateId();
    const envelope = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    };
    const line = encodeLine(envelope);

    return new Promise<T>((resolve, reject) => {
      const timeout = NO_TIMEOUT_METHODS.has(method) ? null : DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = timeout
        ? setTimeout(() => {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              pending.reject(
                new EditorProtocolError({
                  code: EditorErrorCode.Timeout,
                  message: `request ${method} timed out after ${timeout}ms`,
                  method,
                })
              );
            }
          }, timeout)
        : null;

      this.pending.set(id, {
        method,
        resolve: (value: unknown) => {
          const parsed = resultSchema.safeParse(value);
          if (!parsed.success) {
            reject(
              new EditorProtocolError({
                code: EditorErrorCode.InternalError,
                message: `response shape violates schema for ${method}: ${parsed.error.message}`,
                method,
                data: value,
              })
            );
            return;
          }
          resolve(parsed.data);
        },
        reject,
        timer,
      });

      this.sidecar.writeLine(line).catch((err) => {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const envelope = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    await this.sidecar.writeLine(encodeLine(envelope));
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new EditorProtocolError({
          code: EditorErrorCode.Cancelled,
          message: `request aborted: ${reason}`,
          method: pending.method,
        })
      );
    }
    this.pending.clear();
  }

  // ----- inbound dispatch -----

  private handleInboundLine(line: string): void {
    let raw: unknown;
    try {
      raw = parseLine(line);
    } catch (e) {
      logger.warn('inbound line is not valid JSON; dropping', {
        error: (e as Error).message,
        preview: line.slice(0, 120),
      });
      return;
    }
    if (typeof raw !== 'object' || raw === null) {
      logger.warn('inbound is not an object; dropping');
      return;
    }
    const kind = classifyMessage(raw as Record<string, unknown>);
    switch (kind.kind) {
      case 'response':
        this.handleResponse(raw as { id: JsonRpcRequestId; result?: unknown; error?: WireJsonRpcError });
        break;
      case 'request':
        // The only request SNACA sends is `context.request`.
        this.handleInboundRequest(raw as { id: JsonRpcRequestId; method: string; params?: unknown });
        break;
      case 'notification':
        this.handleNotification(raw as { method: string; params?: unknown });
        break;
      case 'invalid':
      default:
        logger.warn('inbound message has invalid envelope; dropping');
    }
  }

  private handleResponse(msg: { id: JsonRpcRequestId; result?: unknown; error?: WireJsonRpcError }): void {
    const id = String(msg.id);
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warn('response for unknown id', { id });
      return;
    }
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new EditorProtocolError({
          code: msg.error.code,
          message: msg.error.message,
          data: msg.error.data,
          method: pending.method,
        })
      );
      return;
    }
    pending.resolve(msg.result ?? null);
  }

  private async handleInboundRequest(msg: {
    id: JsonRpcRequestId;
    method: string;
    params?: unknown;
  }): Promise<void> {
    if (msg.method !== SnacaToHost.ContextRequest) {
      // Send method_not_found back.
      await this.sendResponse(msg.id, {
        error: { code: EditorErrorCode.MethodNotFound, message: msg.method },
      });
      return;
    }

    const parsed = ContextRequestParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      await this.sendResponse(msg.id, {
        error: {
          code: EditorErrorCode.InvalidParams,
          message: `context.request params invalid: ${parsed.error.message}`,
        },
      });
      return;
    }

    const handler = this.contextRequestHandler;
    if (!handler) {
      logger.warn('context.request received but no handler registered');
      const fallback: ContextRespondParams = {
        request_id: parsed.data.request_id,
        ok: false,
        error: 'no context.request handler registered on host',
      };
      await this.sendResponse(msg.id, { result: fallback });
      return;
    }

    try {
      const reply: ContextRespondParams = await handler(parsed.data as ContextRequestParams);
      await this.sendResponse(msg.id, { result: reply });
    } catch (e) {
      logger.warn('context.request handler threw', {
        error: (e as Error).message,
      });
      const fallback: ContextRespondParams = {
        request_id: parsed.data.request_id,
        ok: false,
        error: `host handler error: ${(e as Error).message}`,
      };
      await this.sendResponse(msg.id, { result: fallback });
    }
  }

  private async sendResponse(
    id: JsonRpcRequestId,
    body: { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  ): Promise<void> {
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      id,
    };
    if (body.error) {
      envelope.error = body.error;
    } else {
      envelope.result = body.result ?? null;
    }
    await this.sidecar.writeLine(encodeLine(envelope));
  }

  private handleNotification(msg: { method: string; params?: unknown }): void {
    switch (msg.method) {
      case SnacaToHost.TurnDelta:
        this.parseAndFire(TurnDeltaParamsSchema, msg.params, this._onTurnDelta, msg.method);
        break;
      case SnacaToHost.EditPropose:
        this.parseAndFire(EditProposeParamsSchema, msg.params, this._onEditPropose, msg.method);
        break;
      case SnacaToHost.EditProposeDelta:
        this.parseAndFire(
          EditProposeDeltaParamsSchema,
          msg.params,
          this._onEditProposeDelta,
          msg.method
        );
        break;
      case SnacaToHost.EditProposeComplete:
        this.parseAndFire(
          EditProposeCompleteParamsSchema,
          msg.params,
          this._onEditProposeComplete,
          msg.method
        );
        break;
      case SnacaToHost.PlanUpdate:
        this.parseAndFire(PlanUpdateParamsSchema, msg.params, this._onPlanUpdate, msg.method);
        break;
      case SnacaToHost.ToolApprovalRequest:
        this.parseAndFire(
          ToolApprovalRequestParamsSchema,
          msg.params,
          this._onToolApprovalRequest,
          msg.method
        );
        break;
      case SnacaToHost.UsageUpdate:
        this.parseAndFire(UsageUpdateParamsSchema, msg.params, this._onUsageUpdate, msg.method);
        break;
      case SnacaToHost.MemoryUpdated:
        this.parseAndFire(MemoryUpdatedParamsSchema, msg.params, this._onMemoryUpdated, msg.method);
        break;
      case SnacaToHost.Error:
        this.parseAndFire(
          ErrorNotificationParamsSchema,
          msg.params,
          this._onError,
          msg.method
        );
        break;
      case SnacaToHost.LogWrite:
        this.parseAndFire(LogWriteParamsSchema, msg.params, this._onLog, msg.method);
        break;
      default:
        logger.debug('unknown notification; ignoring', { method: msg.method });
    }
  }

  private parseAndFire<T>(
    schema: ZodType<T>,
    raw: unknown,
    emitter: Emitter<T>,
    method: string
  ): void {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`inbound ${method} schema mismatch; dropping`, {
        error: parsed.error.message,
      });
      return;
    }
    emitter.fire(parsed.data);
  }
}

/**
 * Lightweight passthrough schema for tiny one-off shapes (`{ ok }`, `{ closed }`,
 * etc.) where structural validation would just duplicate the Rust side's
 * already-tight types. Validates only that the inbound payload is a plain
 * object.
 */
const ANONYMOUS_OBJECT_SCHEMA = z.record(z.string(), z.unknown());
function anonymousSchema<T>(): ZodType<T> {
  return ANONYMOUS_OBJECT_SCHEMA as unknown as ZodType<T>;
}

/**
 * Factory matching the `ServiceRegistry.registerSingleton` convention.
 */
export function createEditorProtocolClient(deps: {
  sidecar: ISnacaSidecarService;
}): IEditorProtocolClient {
  return new EditorProtocolClient(deps.sidecar);
}
