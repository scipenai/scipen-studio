/**
 * @file SnacaSidecarService
 * @description Owns the snaca-editor child process. Spawn, supervise, pipe
 *   stdin/stdout/stderr, auto-restart with exponential backoff, graceful
 *   shutdown.
 *
 *   No JSON-RPC knowledge — that lives in `EditorProtocolClient`. This
 *   service trafficks in bytes and NDJSON-framed lines.
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { Emitter, type Event } from '../../../../shared/utils/event';
import { Disposable, DisposableStore, type IDisposable } from '../../../../shared/utils/lifecycle';
import { LineBuffer } from './protocol/envelope';
import type {
  ISnacaSidecarService,
  SidecarOptions,
  SidecarState,
} from './interfaces/ISnacaSidecarService';
import { createLogger } from '../LoggerService';

const logger = createLogger('SnacaSidecarService');

const DEFAULT_BACKOFF = {
  baseMs: 500,
  maxMs: 60_000,
  maxAttempts: 10,
};

type ChildHandle = ChildProcessByStdio<Writable, Readable, Readable>;

export class SnacaSidecarService extends Disposable implements ISnacaSidecarService {
  private readonly _onStateChange = this._register(new Emitter<SidecarState>());
  private readonly _onStdoutLine = this._register(new Emitter<string>());
  private readonly _onStderr = this._register(new Emitter<string>());

  readonly onStateChange: Event<SidecarState> = this._onStateChange.event;
  readonly onStdoutLine: Event<string> = this._onStdoutLine.event;
  readonly onStderr: Event<string> = this._onStderr.event;

  private _state: SidecarState = { kind: 'stopped' };
  private child: ChildHandle | null = null;
  private childListeners: DisposableStore | null = null;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** True when caller invoked `stop()` deliberately — disables auto-restart. */
  private stopRequested = false;
  private readonly stdoutBuffer = new LineBuffer();

  constructor(private readonly opts: SidecarOptions) {
    super();
  }

  get state(): SidecarState {
    return this._state;
  }

  isRunning(): boolean {
    return this._state.kind === 'running';
  }

  // ----------- public API -----------

  async start(): Promise<void> {
    if (this._state.kind === 'running' || this._state.kind === 'starting') {
      logger.debug('start() called while already running/starting; ignoring');
      return;
    }
    this.stopRequested = false;
    this.cancelRestartTimer();
    await this.spawnOnce();
  }

  async stop(opts: { graceful?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const { graceful = true, timeoutMs = 3000 } = opts;
    this.stopRequested = true;
    this.cancelRestartTimer();

    if (!this.child || this._state.kind === 'stopped') {
      this.setState({ kind: 'stopped' });
      return;
    }

    this.setState({ kind: 'stopping' });

    const child = this.child;
    if (graceful) {
      // Close stdin → child sees EOF → exits its loop.
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      const exited = await this.waitForExit(timeoutMs);
      if (!exited) {
        logger.warn('child did not exit within graceful window; killing');
        try {
          child.kill('SIGKILL');
        } catch (e) {
          logger.warn('kill failed', { error: (e as Error).message });
        }
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        logger.warn('kill failed', { error: (e as Error).message });
      }
    }
    // ChildHandle.on('exit') will move state to 'stopped' / 'crashed'.
  }

  async restart(): Promise<void> {
    this.restartAttempt = 0;
    await this.stop({ graceful: true });
    await this.start();
  }

  async writeLine(line: string): Promise<void> {
    if (!this.child || this._state.kind !== 'running') {
      throw new Error(`snaca-editor not running (state=${this._state.kind})`);
    }
    const data = line.endsWith('\n') ? line : `${line}\n`;
    return new Promise<void>((resolve, reject) => {
      // `write` returns false when the internal buffer is full; subscribe to
      // 'drain' to know when to resolve. For our message sizes this rarely
      // backpressures, but the contract is honored.
      const ok = this.child!.stdin.write(data, (err) => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
      } else {
        this.child!.stdin.once('drain', () => resolve());
      }
    });
  }

  override dispose(): void {
    this.stopRequested = true;
    this.cancelRestartTimer();
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.childListeners?.dispose();
    this.childListeners = null;
    super.dispose();
  }

  // ----------- internals -----------

  private setState(next: SidecarState): void {
    this._state = next;
    this._onStateChange.fire(next);
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private async spawnOnce(): Promise<void> {
    this.setState({ kind: 'starting' });
    this.stdoutBuffer.reset();

    const args: string[] = [];
    if (this.opts.configPath) {
      args.push('--config', this.opts.configPath);
    }
    if (this.opts.logFilter) {
      args.push('--log-filter', this.opts.logFilter);
    }

    // Resolve `env` lazily so live changes in Studio Settings (api key /
    // base url) take effect on the next spawn without rewiring DI.
    const resolvedEnv = typeof this.opts.env === 'function' ? this.opts.env() : this.opts.env;

    let child: ChildHandle;
    try {
      child = spawn(this.opts.binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...resolvedEnv },
        windowsHide: true,
      }) as ChildHandle;
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('spawn failed', { error: msg, binary: this.opts.binaryPath });
      this.handleCrash(`spawn failed: ${msg}`);
      return;
    }

    const pid = child.pid ?? 0;
    if (!pid) {
      // `spawn` already fired 'error'; handleCrash will be called via listener.
      logger.warn('spawn returned without pid; awaiting error event');
    }

    this.child = child;
    this.childListeners = new DisposableStore();
    this.attachListeners(child);

    this.setState({ kind: 'running', pid, startedAt: Date.now() });
    this.restartAttempt = 0;
    logger.info('snaca-editor spawned', { pid, binary: this.opts.binaryPath });
  }

  private attachListeners(child: ChildHandle): void {
    const store = this.childListeners!;

    const onStdout = (chunk: Buffer | string): void => {
      try {
        const lines = this.stdoutBuffer.push(chunk);
        for (const line of lines) {
          this._onStdoutLine.fire(line);
        }
      } catch (e) {
        logger.error('stdout line buffer error', { error: (e as Error).message });
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this._onStderr.fire(text);
    };
    const onError = (err: Error): void => {
      logger.error('child error', { error: err.message });
      this.handleCrash(err.message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const reason =
        code != null ? `exit code ${code}` : signal != null ? `signal ${signal}` : 'unknown';
      logger.info('snaca-editor exited', { reason, pid: child.pid });
      this.detachListeners();
      this.child = null;
      if (this.stopRequested || code === 0) {
        this.setState({ kind: 'stopped' });
      } else {
        this.handleCrash(reason);
      }
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);

    store.add({
      dispose: () => {
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('exit', onExit);
      },
    });
  }

  private detachListeners(): void {
    this.childListeners?.dispose();
    this.childListeners = null;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = this.child;
      if (!child) {
        resolve(true);
        return;
      }
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  private handleCrash(reason: string): void {
    const autoRestart = this.opts.autoRestart !== false;
    const backoff = { ...DEFAULT_BACKOFF, ...(this.opts.backoff ?? {}) };

    if (this.stopRequested || !autoRestart) {
      this.setState({ kind: 'stopped' });
      return;
    }

    this.restartAttempt += 1;
    if (this.restartAttempt > backoff.maxAttempts) {
      logger.error('max restart attempts reached; giving up', {
        attempts: this.restartAttempt - 1,
        reason,
      });
      this.setState({ kind: 'stopped' });
      return;
    }

    const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (this.restartAttempt - 1));
    // Add small jitter (±20%) to avoid thundering herd on multi-window setups.
    const jitter = exp * 0.2 * (Math.random() - 0.5) * 2;
    const delay = Math.max(0, Math.round(exp + jitter));
    const retryAt = Date.now() + delay;

    this.setState({
      kind: 'crashed',
      lastError: reason,
      retryAt,
      attempt: this.restartAttempt,
    });

    logger.warn('scheduling restart', {
      attempt: this.restartAttempt,
      delayMs: delay,
      reason,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnOnce();
    }, delay);
  }
}

/**
 * Factory matching the `ServiceRegistry.registerSingleton` convention.
 */
export function createSnacaSidecarService(opts: SidecarOptions): ISnacaSidecarService {
  return new SnacaSidecarService(opts);
}

interface DisposableLike extends IDisposable {}
// re-export to keep eslint happy with unused warning if interface narrowing
// is not used elsewhere in the file.
export type { DisposableLike };
