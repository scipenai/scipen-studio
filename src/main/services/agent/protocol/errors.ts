/**
 * @file editor-protocol error codes
 * @description Mirror of `snaca-editor-protocol::error::ErrorCode`. Same
 *   numeric codes as the Rust side; symbolic names use TypeScript enum
 *   conventions.
 *
 * @see docs/editor-protocol.md §14
 */

export enum EditorErrorCode {
  // --- JSON-RPC standard ---
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // --- Editor-protocol application errors ---
  NotInitialized = -32000,
  SessionNotFound = -32001,
  ThreadNotFound = -32002,
  TurnNotFound = -32003,
  ProposalNotFound = -32004,
  InflightTurnBusy = -32005,
  CapabilityNotSupported = -32006,
  ConfigInvalid = -32007,
  WorkspaceInvalid = -32008,
  LlmAuthFailed = -32009,
  LlmContextOverflow = -32010,
  LlmRateLimited = -32011,
  BaseHashMismatch = -32012,
  Cancelled = -32013,
  Timeout = -32014,
}

/**
 * Human-readable symbol for an error code (for logging / UI fallback when
 * a structured message is not available).
 */
export function errorCodeSymbol(code: number): string {
  switch (code) {
    case EditorErrorCode.ParseError:
      return 'parse_error';
    case EditorErrorCode.InvalidRequest:
      return 'invalid_request';
    case EditorErrorCode.MethodNotFound:
      return 'method_not_found';
    case EditorErrorCode.InvalidParams:
      return 'invalid_params';
    case EditorErrorCode.InternalError:
      return 'internal_error';
    case EditorErrorCode.NotInitialized:
      return 'not_initialized';
    case EditorErrorCode.SessionNotFound:
      return 'session_not_found';
    case EditorErrorCode.ThreadNotFound:
      return 'thread_not_found';
    case EditorErrorCode.TurnNotFound:
      return 'turn_not_found';
    case EditorErrorCode.ProposalNotFound:
      return 'proposal_not_found';
    case EditorErrorCode.InflightTurnBusy:
      return 'inflight_turn_busy';
    case EditorErrorCode.CapabilityNotSupported:
      return 'capability_not_supported';
    case EditorErrorCode.ConfigInvalid:
      return 'config_invalid';
    case EditorErrorCode.WorkspaceInvalid:
      return 'workspace_invalid';
    case EditorErrorCode.LlmAuthFailed:
      return 'llm_auth_failed';
    case EditorErrorCode.LlmContextOverflow:
      return 'llm_context_overflow';
    case EditorErrorCode.LlmRateLimited:
      return 'llm_rate_limited';
    case EditorErrorCode.BaseHashMismatch:
      return 'base_hash_mismatch';
    case EditorErrorCode.Cancelled:
      return 'cancelled';
    case EditorErrorCode.Timeout:
      return 'timeout';
    default:
      return 'other';
  }
}

/**
 * Strongly-typed error thrown by `EditorProtocolClient` when an RPC fails.
 * Wraps the JSON-RPC error envelope plus the originating method.
 */
export class EditorProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method?: string;

  constructor(opts: { code: number; message: string; data?: unknown; method?: string }) {
    super(opts.message);
    this.name = 'EditorProtocolError';
    this.code = opts.code;
    this.data = opts.data;
    this.method = opts.method;
  }

  get symbol(): string {
    return errorCodeSymbol(this.code);
  }

  /** True when the error indicates a precondition rather than a transient fault. */
  get isPrecondition(): boolean {
    return (
      this.code === EditorErrorCode.NotInitialized ||
      this.code === EditorErrorCode.SessionNotFound ||
      this.code === EditorErrorCode.ThreadNotFound ||
      this.code === EditorErrorCode.InflightTurnBusy ||
      this.code === EditorErrorCode.CapabilityNotSupported
    );
  }
}
