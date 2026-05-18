/**
 * @file IEditorProtocolClient - JSON-RPC client for the editor protocol.
 * @description Sits on top of `ISnacaSidecarService`. Encodes requests,
 *   correlates responses, validates inbound payloads with Zod, and surfaces
 *   typed events for streamed notifications.
 *
 *   Methods follow the spec one-to-one. Long-running operations (`chat.send`,
 *   etc.) resolve as soon as snaca-editor returns the synchronous response
 *   (the `turn_id`). The actual streamed work arrives via the `onTurn*` and
 *   `onEdit*` events.
 *
 * @see docs/editor-protocol.md
 */

import type { Event } from '@shared/utils/event';
import type { IDisposable } from '@shared/utils/lifecycle';
import type {
  ChatSendParams,
  ChatSendResult,
  ComposerStartParams,
  ComposerStartResult,
  ConfigReloadResult,
  ContextRequestParams,
  ContextRespondParams,
  EditConfirmParams,
  EditConfirmResult,
  EditProposeCompleteParams,
  EditProposeDeltaParams,
  EditProposeParams,
  ErrorNotificationParams,
  HealthPingResult,
  InitParams,
  InitResult,
  InlineEditStartParams,
  InlineEditStartResult,
  LogWriteParams,
  MemoryUpdatedParams,
  PlanConfirmParams,
  PlanConfirmResult,
  PlanUpdateParams,
  SessionListThreadsResult,
  SessionNewThreadResult,
  SessionOpenParams,
  SessionOpenResult,
  SessionSwitchThreadResult,
  SnacaConfig,
  ToolApprovalRequestParams,
  ToolConfirmParams,
  TurnCancelParams,
  TurnDeltaParams,
  UsageUpdateParams,
} from '../protocol/schemas';

/**
 * Connection-level events. `connected` fires after a successful `init`,
 * `disconnected` when the underlying sidecar exits.
 */
export type ClientConnectionState =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; engineVersion: string; protocolVersion: string };

/**
 * Reverse-RPC: SNACA asks the host for some context. The host MUST eventually
 * call `respondContext` with the same `request_id`. If the host throws / rejects,
 * the client auto-replies with `ok: false` so the SNACA side doesn't hang.
 */
export type ContextRequestHandler = (req: ContextRequestParams) => Promise<ContextRespondParams>;

export interface IEditorProtocolClient extends Partial<IDisposable> {
  // ---------------- Lifecycle observation ----------------

  readonly state: ClientConnectionState;
  readonly onStateChange: Event<ClientConnectionState>;

  // ---------------- Lifecycle methods ----------------

  /** Run handshake; safe to call again after a disconnect/restart. */
  init(params: InitParams): Promise<InitResult>;
  shutdown(): Promise<{ ok: boolean }>;
  healthPing(): Promise<HealthPingResult>;
  configReload(snacaConfig: SnacaConfig): Promise<ConfigReloadResult>;

  // ---------------- Session ----------------

  sessionOpen(params: SessionOpenParams): Promise<SessionOpenResult>;
  sessionClose(sessionId: string): Promise<{ closed: boolean }>;
  sessionListThreads(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SessionListThreadsResult>;
  sessionNewThread(sessionId: string, title?: string): Promise<SessionNewThreadResult>;
  sessionSwitchThread(sessionId: string, threadId: string): Promise<SessionSwitchThreadResult>;
  sessionDeleteThread(sessionId: string, threadId: string): Promise<{ deleted: boolean }>;
  sessionRenameThread(
    sessionId: string,
    threadId: string,
    title: string
  ): Promise<{ renamed: boolean }>;

  // ---------------- Agent surfaces ----------------

  chatSend(params: ChatSendParams): Promise<ChatSendResult>;
  inlineEditStart(params: InlineEditStartParams): Promise<InlineEditStartResult>;
  composerStart(params: ComposerStartParams): Promise<ComposerStartResult>;
  planConfirm(params: PlanConfirmParams): Promise<PlanConfirmResult>;

  // ---------------- Control ----------------

  /** Fire-and-forget. */
  turnCancel(params: TurnCancelParams): Promise<void>;
  editConfirm(params: EditConfirmParams): Promise<EditConfirmResult>;
  toolConfirm(params: ToolConfirmParams): Promise<{ ok: boolean }>;

  // ---------------- Reverse RPC ----------------

  /**
   * Register a handler that will be invoked when SNACA sends a
   * `context.request`. Returns a disposable to unregister.
   *
   * Only one handler may be registered at a time; subsequent registrations
   * replace the previous handler and return the new disposable.
   */
  setContextRequestHandler(handler: ContextRequestHandler): IDisposable;

  // ---------------- Notification events ----------------

  readonly onTurnDelta: Event<TurnDeltaParams>;
  readonly onEditPropose: Event<EditProposeParams>;
  readonly onEditProposeDelta: Event<EditProposeDeltaParams>;
  readonly onEditProposeComplete: Event<EditProposeCompleteParams>;
  readonly onPlanUpdate: Event<PlanUpdateParams>;
  readonly onToolApprovalRequest: Event<ToolApprovalRequestParams>;
  readonly onUsageUpdate: Event<UsageUpdateParams>;
  readonly onMemoryUpdated: Event<MemoryUpdatedParams>;
  readonly onError: Event<ErrorNotificationParams>;
  readonly onLog: Event<LogWriteParams>;
}
