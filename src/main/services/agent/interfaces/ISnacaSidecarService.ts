/**
 * @file ISnacaSidecarService - snaca-editor process lifecycle contract.
 * @description Owns the snaca-editor child process: spawn / restart /
 *   shutdown, plus stdout/stderr piping. Bytes flow but no protocol
 *   knowledge — `EditorProtocolClient` layers JSON-RPC on top.
 */

import type { Event } from '@shared/utils/event';
import type { IDisposable } from '@shared/utils/lifecycle';

/**
 * State of the snaca-editor child process. Emitted on every transition.
 */
export type SidecarState =
  | { kind: 'stopped' }
  | { kind: 'starting'; pid?: number }
  | { kind: 'running'; pid: number; startedAt: number }
  | { kind: 'crashed'; lastError: string; retryAt: number; attempt: number }
  | { kind: 'stopping' };

export interface SidecarOptions {
  /** Absolute path to the snaca-editor binary. */
  binaryPath: string;
  /** Optional `--config` path passed to the binary. */
  configPath?: string;
  /** Optional `--log-filter` override. */
  logFilter?: string;
  /**
   * Env additions for the spawned process. Sensitive values (`SNACA_API_KEY`)
   * must be supplied here — never inside `snaca.toml`.
   *
   * May be either a static record or a getter resolved at each spawn so
   * Studio Settings (api key / base url) flow into the next sidecar
   * instance after a restart.
   */
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Auto-restart on unexpected exit. Default true. */
  autoRestart?: boolean;
  /**
   * Restart backoff config (base * 2^attempt clamped to max). Defaults:
   * baseMs=500, maxMs=60_000, maxAttempts=10.
   */
  backoff?: { baseMs?: number; maxMs?: number; maxAttempts?: number };
}

export interface ISnacaSidecarService extends Partial<IDisposable> {
  /** Current process state. Sync read. */
  readonly state: SidecarState;
  /**
   * Absolute path of the binary this service spawns. Exposed so other
   * handlers (e.g. the fastembed pre-download flow) can launch the
   * same executable with alternate CLI flags without duplicating the
   * path-resolution logic.
   */
  readonly binaryPath: string;
  /** Env additions injected into each spawn. Resolved fresh each time
   *  so Settings changes propagate after a restart. Exposed for
   *  one-off subprocess launches (e.g. fastembed pre-download) that
   *  want the same `SNACA_API_KEY` / `SCIPEN_FASTEMBED_CACHE_DIR`
   *  routing the sidecar gets. */
  resolveEnv(): NodeJS.ProcessEnv;
  /** Emitted on every `state` transition. */
  readonly onStateChange: Event<SidecarState>;
  /** Emitted whenever a complete stdout line arrives (NDJSON frame). */
  readonly onStdoutLine: Event<string>;
  /** Emitted on every stderr chunk (for log fan-out). */
  readonly onStderr: Event<string>;

  /** Spawn the process. No-op if already running. */
  start(): Promise<void>;

  /**
   * Send a request to stop the process. `graceful = true` first calls
   * `shutdown` (out-of-band JSON-RPC by the protocol client); when false
   * the process is SIGKILLed immediately.
   *
   * NOTE: This service does not speak JSON-RPC. Graceful shutdown should
   * be coordinated by `EditorProtocolClient` first; the sidecar then calls
   * `stop({ graceful: false })` after the ack to close stdin and wait for
   * exit.
   */
  stop(opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;

  /** Stop + Start. Backoff counters reset. */
  restart(): Promise<void>;

  /** True when state.kind === 'running'. */
  isRunning(): boolean;

  /**
   * Write one NDJSON-framed line to the child stdin. Adds the `\n`
   * terminator. Resolves when the byte buffer is accepted (not when the
   * far end has read).
   *
   * @throws If process is not running.
   */
  writeLine(line: string): Promise<void>;
}
