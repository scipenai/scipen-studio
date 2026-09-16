/**
 * @file BusyTexProcessClient.ts — main-process client for the BusyTeX
 *   engine's UtilityProcess.
 *
 * Owns the child process lifecycle: spawn, request/response correlation,
 * print-event forwarding, crash restart with backoff, and teardown. Follows
 * the LSPProcessClient pattern; the two exist as separate clients because
 * their failure domains are independent (an LSP crash should not take down a
 * running compile, and vice versa).
 *
 * The renderer never talks to this client directly — it goes through IPC
 * (`Compile_BusyTeX` / `Compile_CancelBusyTeX` handlers), which validate
 * paths before anything reaches here.
 *
 * Module-level singleton via {@link getBusyTexProcessClient} (the Zotero
 * services' precedent): spawning is expensive and must be lazy, and nothing
 * else in the container needs to reach past this facade.
 */

import { app, utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'node:path';
import { Emitter, type Event } from '../../../shared/utils';
import { createLogger } from './LoggerService';
import { parseBusyTexPrintLine, createBusyTexPhaseState } from './compilePhaseParser';
import type { CompileProgressPayload } from '../../../shared/ipc/compile-contract';
import { resolveWasmRoot } from './WasmAssetProtocol';

const logger = createLogger('BusyTexProcessClient');

/**
 * Error message used when the engine is torn down on purpose (stop button or
 * idle release). The IPC handler matches it to report a neutral "cancelled"
 * outcome instead of a red failure.
 */
export const BUSYTEX_STOPPED_MESSAGE = 'BusyTeX engine was stopped';

/** Release the engine process after this long without activity. */
const IDLE_RELEASE_MS = 10 * 60_000;

// ====== Wire types ======

export interface BusyTexCompileRequest {
  /** Full staged file set (current buffer + siblings + figures), project-relative. */
  files: Array<{ path: string; contents: string; encoding?: 'utf8' | 'base64' }>;
  mainFile: string;
  driver: string;
  endpoint: string;
  outputDir: string;
  baseName: string;
}

export interface BusyTexCompileResult {
  exitCode: number;
  pdfPath?: string;
  synctexPath?: string;
  log: string;
}

type ResponseMessage = {
  type: 'response';
  id: string;
  result?: unknown;
  error?: { message: string };
};
type EventMessage = { type: 'event'; event: string; data: unknown };
type IncomingMessage = ResponseMessage | EventMessage;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ====== Client ======

class BusyTexProcessClientImpl {
  private process: UtilityProcess | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;
  private starting = false;
  /**
   * True from the moment an intentional teardown begins (stop button /
   * idle release) until the process's exit event is observed. The exit
   * handler uses it to classify the exit: intentional stops surface as the
   * neutral stopped message, everything else as a crash.
   */
  private stopping = false;
  private loaded = false;
  /** Per-load print parser state (pass counting across the compile's prints). */
  private phaseState = createBusyTexPhaseState();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _onPrint = new Emitter<string>();
  readonly onPrint: Event<string> = this._onPrint.event;

  /**
   * Compile phases parsed from the engine's stdout prints (pass counters,
   * package-load percentages) plus synthetic engine-load/staging markers.
   * `CompileHandlers` forwards these to the renderer over `Compile_Progress`.
   */
  private readonly _onPhase = new Emitter<CompileProgressPayload>();
  readonly onPhase: Event<CompileProgressPayload> = this._onPhase.event;

  private getProcessPath(): string {
    if (app.isPackaged) {
      return path.join(
        process.resourcesPath,
        'app.asar',
        'out',
        'main',
        'busytex-process',
        'index.cjs'
      );
    }
    return path.join(__dirname, 'busytex-process', 'index.cjs');
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  /** @sideeffect Spawns the UtilityProcess and wires listeners */
  private async ensureProcess(): Promise<UtilityProcess> {
    if (this.process) return this.process;
    if (this.starting) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!this.starting) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      if (this.process) return this.process;
    }

    this.starting = true;
    try {
      const processPath = this.getProcessPath();
      logger.info('Starting BusyTeX engine process', { path: processPath });

      const proc = utilityProcess.fork(processPath, [], {
        serviceName: 'scipen-busytex',
        execArgv: [],
        // Utility processes cannot call app.getPath(); inject via env.
        env: {
          ...process.env,
          WASM_ASSETS_DIR: resolveWasmRoot() + '/busytex',
          TEXLIVE_CACHE_DIR: path.join(
            app.getPath('userData'),
            'scipen-studio',
            'texlive-remote-cache'
          ),
        },
      });

      proc.on('message', (message: IncomingMessage) => this.handleMessage(message));
      proc.on('exit', (code) => {
        const intentional = this.stopping;
        this.stopping = false;
        logger.info('BusyTeX engine process exited', { code, intentional });
        this.process = null;
        this.loaded = false;
        this.clearIdleTimer();
        // The in-flight load died with the process. Clearing it here lets the
        // next caller start a fresh load against the replacement process —
        // keeping the stale promise would hang every future compile until
        // timeout (cancel-during-cold-start, exactly the switch-files case).
        this.loadPromise = null;
        // Classification: the stop button and the idle release kill the
        // process on purpose — pending compiles surface as the neutral
        // stopped message. Any OTHER exit with requests in flight is a
        // crash (segfault / OOM are realistic with a multi-GB wasm heap)
        // and must reach the user as a real error, not silently read as
        // "cancelled".
        this.rejectAllPending(
          intentional
            ? new Error(BUSYTEX_STOPPED_MESSAGE)
            : new Error(`BusyTeX engine crashed (exit code ${code ?? 'unknown'})`)
        );
      });

      // Wait for the child's `ready` event so spawn success is a real signal
      // that the entry script loaded, not just that the OS fork returned.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Kill the untracked child — a spawned-but-never-ready process
          // would otherwise linger forever, and the next attempt would fork
          // a SECOND engine alongside it.
          proc.kill();
          reject(new Error('engine process start timeout'));
        }, this.startTimeoutMs);
        const onMessage = (message: IncomingMessage) => {
          if (message.type === 'event' && message.event === 'ready') {
            clearTimeout(timer);
            proc.off('message', onMessage);
            resolve();
          }
        };
        proc.on('message', onMessage);
        proc.on('exit', () => {
          clearTimeout(timer);
          reject(new Error('engine process exited during start'));
        });
      });

      this.process = proc;
      // Fresh process — a previous intentional stop no longer applies.
      this.stopping = false;
      return proc;
    } finally {
      this.starting = false;
    }
  }

  private handleMessage(message: IncomingMessage): void {
    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.type === 'event' && message.event === 'print') {
      const data = message.data as { line?: string } | null;
      if (!data?.line) return;
      this._onPrint.fire(data.line);
      // Prints carry the phase signal (pass counters, data-package load
      // percentages). Parse and re-emit so the renderer's progress UI works
      // exactly as it did when the engine lived in the renderer.
      const phase = parseBusyTexPrintLine(data.line, this.phaseState);
      if (phase) this._onPhase.fire(phase);
    }
  }

  // ====== Idle release ======

  /**
   * Idle window before the engine process is released. Instance field (not
   * a constant) so tests can shorten it and exercise the release with real
   * timers instead of a fake clock — the fake clock's state leaks across
   * module re-evaluations in ways that make timing assertions flaky.
   */
  idleReleaseMs = IDLE_RELEASE_MS;
  /**
   * How long to wait for the child's `ready` event. Instance field so tests
   * can shorten it instead of waiting out the production 15 s.
   */
  startTimeoutMs = 15_000;
  //
  // The engine's Emscripten heap never shrinks; tearing the process down is
  // the only way to give the memory back. The window is measured from the
  // last load/compile so an active edit-compile loop never trips it (a reload
  // costs ~20 s, far more than the memory is worth mid-session).

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleRelease(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.process) return;
      // A compile can legitimately run up to the 600 s request cap — longer
      // than one idle window. Never release under in-flight work; re-arm and
      // release once the engine is actually quiescent.
      if (this.pendingRequests.size > 0) {
        this.armIdleRelease();
        return;
      }
      logger.info('BusyTeX engine released after idle period');
      this.release();
    }, this.idleReleaseMs);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const proc = await this.ensureProcess();
    const id = `req_${++this.requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`BusyTeX request '${method}' timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      proc.postMessage({ id, type: 'request', method, params });
    });
  }

  /**
   * Load the pipeline (idempotent). ~120 MB on first call per process
   * lifetime; subsequent calls are no-ops on the child side.
   */
  /** In-flight load shared by concurrent callers — two compiles racing at
   *  startup would otherwise both send `load`, and the second importScripts
   *  crashes the child with "Identifier ... already been declared". */
  private loadPromise: Promise<void> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.phaseState = createBusyTexPhaseState();
    this._onPhase.fire({
      engine: 'latex',
      stage: 'engine-load',
      message: 'Loading BusyTeX engine (wasm + TeX Live data packages)',
    });
    // NOTE: a failed `load` request is intentionally NOT retried against
    // `this.process` here, even if it is still set. `importScripts` on the
    // child declares top-level classes as a side effect that cannot be
    // undone — resending `load` to a process that already received one
    // (dead, still mid-init, or merely slow) reruns importScripts and
    // crashes the child with "Identifier ... already been declared". A
    // failed load always surfaces to the caller; the *next* call to
    // ensureLoaded() (this compile's retry, or the file the user switched
    // to) starts a fresh loadPromise and — if the process died — a fresh
    // process, which is the only safe way to retry.
    this.loadPromise = (async () => {
      try {
        await this.request('load', undefined, this.LOAD_TIMEOUT);
        this.loaded = true;
        this.armIdleRelease();
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  /** Run one compile. Artifacts are written by the child; paths come back. */
  async compile(request: BusyTexCompileRequest): Promise<BusyTexCompileResult> {
    try {
      // A compile without a loaded engine fails on the child side ("engine
      // not loaded") — e.g. a user who never warmed via Prepare. Load first.
      await this.ensureLoaded();
      const result = await this.request<BusyTexCompileResult>(
        'compile',
        request,
        this.COMPILE_TIMEOUT
      );
      this.armIdleRelease();
      return result;
    } catch (err) {
      // A failed compile still leaves a loaded engine behind — re-arm so the
      // idle release runs even for failing documents.
      if (this.process) this.armIdleRelease();
      throw err;
    }
  }

  private readonly COMPILE_TIMEOUT = 600_000;
  private readonly LOAD_TIMEOUT = 300_000;

  /**
   * Tear the process down. Used by the idle-memory release and the renderer's
   * stop button: a compile in flight rejects, the OS reclaims the heap, and
   * the next use respawns and reloads lazily.
   */
  kill(): void {
    this.clearIdleTimer();
    this.stopping = true;
    this.loadPromise = null;
    this.loaded = false;
    this.rejectAllPending(new Error(BUSYTEX_STOPPED_MESSAGE));
    this.process?.kill();
    this.process = null;
  }

  /**
   * Ask the child to flush and exit politely (idle-memory release). Falls
   * back to kill() if it does not exit promptly.
   */
  async release(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.clearIdleTimer();
    // The child exits itself on release — mark intentional before asking.
    this.stopping = true;
    try {
      await this.request('release', undefined, 3_000);
    } catch {
      // Expected: the child exits before answering.
    }
    // `exit` handler clears this.process; kill only if it lingers.
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    // Unconditional: once released, nothing is loaded — even when the child
    // had already exited on its own and skipped the handshake above.
    this.loadPromise = null;
    this.loaded = false;
  }
}

type BusyTexProcessClient = InstanceType<typeof BusyTexProcessClientImpl>;

let instance: BusyTexProcessClient | null = null;

export function getBusyTexProcessClient(): BusyTexProcessClient {
  if (!instance) instance = new BusyTexProcessClientImpl();
  return instance;
}

export type { BusyTexProcessClient };
