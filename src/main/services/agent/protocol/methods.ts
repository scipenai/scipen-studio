/**
 * @file editor-protocol method name constants
 * @description Mirrors `snaca-editor-protocol::messages::host_to_snaca` /
 *   `snaca_to_host`. Using these constants instead of string literals at
 *   call sites lets the typechecker catch typos and lets renames sweep the
 *   codebase mechanically.
 *
 * @see docs/editor-protocol.md §10 / §11
 */

/** Methods the host sends to snaca-editor. */
export const HostToSnaca = {
  // Lifecycle
  Init: 'init',
  Shutdown: 'shutdown',
  HealthPing: 'health.ping',
  ConfigReload: 'config.reload',
  // Session
  SessionOpen: 'session.open',
  SessionClose: 'session.close',
  SessionListThreads: 'session.list_threads',
  SessionNewThread: 'session.new_thread',
  SessionSwitchThread: 'session.switch_thread',
  SessionDeleteThread: 'session.delete_thread',
  SessionRenameThread: 'session.rename_thread',
  // Agent surfaces
  ChatSend: 'chat.send',
  InlineEditStart: 'inline_edit.start',
  ComposerStart: 'composer.start',
  PlanConfirm: 'plan.confirm',
  // Control
  TurnCancel: 'turn.cancel',
  EditConfirm: 'edit.confirm',
  ToolConfirm: 'tool.confirm',
  ContextRespond: 'context.respond',
} as const;

export type HostToSnacaMethod = (typeof HostToSnaca)[keyof typeof HostToSnaca];

/** Methods snaca-editor sends to the host. */
export const SnacaToHost = {
  TurnDelta: 'turn.delta',
  EditPropose: 'edit.propose',
  EditProposeDelta: 'edit.propose_delta',
  EditProposeComplete: 'edit.propose_complete',
  PlanUpdate: 'plan.update',
  /** Reverse RPC — has an id, host must respond via `context.respond`. */
  ContextRequest: 'context.request',
  ToolApprovalRequest: 'tool.approval_request',
  UsageUpdate: 'usage.update',
  MemoryUpdated: 'memory.updated',
  Error: 'error',
  LogWrite: 'log.write',
} as const;

export type SnacaToHostMethod = (typeof SnacaToHost)[keyof typeof SnacaToHost];

/** Editor-protocol wire version implemented by this client. */
export const EDITOR_PROTOCOL_VERSION = '1.0';
