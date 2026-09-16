/**
 * Tests for BusyTexProcessClient — the main-process client for the BusyTeX
 * engine's UtilityProcess.
 *
 * Covered here: request correlation across the forked process, print→phase
 * parsing, the idle-release timer, and the neutral stopped-message contract
 * the IPC handler matches on. The child itself is a fake UtilityProcess so
 * tests control message timing precisely.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const childState = vi.hoisted(() => ({
  /** Messages posted by the client, in order (for assertions). */
  sent: [] as Array<Record<string, unknown>>,
  /** Inject a message from the fake child. */
  emit: null as ((msg: unknown) => void) | null,
  /** Simulate the child process exiting (self-terminate or OS kill). */
  exit: null as ((code: number) => void) | null,
  /** Whether a freshly forked fake child announces `ready` (default true). */
  autoReady: true,
  killed: 0,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/userdata' },
  utilityProcess: {
    fork: () => {
      childState.sent = [];
      childState.killed = 0;
      const listeners = new Map<string, Set<(v: unknown) => void>>();
      const fake = {
        on: (event: string, cb: (v: unknown) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(cb);
          return fake;
        },
        off: (event: string, cb: (v: unknown) => void) => {
          listeners.get(event)?.delete(cb);
          return fake;
        },
        postMessage: (msg: unknown) => {
          childState.sent.push(msg as Record<string, unknown>);
        },
        kill: () => {
          childState.killed += 1;
          return fake;
        },
        __emit: (msg: unknown) => {
          for (const cb of listeners.get('message') ?? []) cb(msg);
        },
        __exit: (code: number) => {
          for (const cb of listeners.get('exit') ?? []) cb(code);
        },
      };
      childState.emit = (msg: unknown) => fake.__emit(msg);
      childState.exit = (code: number) => fake.__exit(code);
      // The real child announces `ready` once its shims are installed.
      if (childState.autoReady) {
        queueMicrotask(() => fake.__emit({ type: 'event', event: 'ready', data: null }));
      }
      return fake;
    },
  },
}));

import {
  BUSYTEX_STOPPED_MESSAGE,
  getBusyTexProcessClient,
} from '../../src/main/services/BusyTexProcessClient';
import type { BusyTexCompileRequest } from '../../src/main/services/BusyTexProcessClient';

/** Flush the microtask queue so the client's async fork/request chain lands. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function compileRequest(contents = 'x'): BusyTexCompileRequest {
  return {
    files: [{ path: 'main.tex', contents }],
    mainFile: 'main.tex',
    driver: 'pdftex_bibtex8',
    endpoint: '',
    outputDir: '/tmp/out',
    baseName: 'main',
  };
}

function respondOk(result: unknown): void {
  childState.emit?.({ type: 'response', id: String(lastSent().id), result });
}

function lastSent(): Record<string, unknown> {
  return childState.sent[childState.sent.length - 1];
}

describe('BusyTexProcessClient', () => {
  let client: ReturnType<typeof getBusyTexProcessClient>;

  beforeEach(() => {
    childState.autoReady = true;
    client = getBusyTexProcessClient();
  });

  afterEach(() => {
    client.kill();
    vi.useRealTimers();
  });

  it('correlates load and compile requests and parses prints into phases', async () => {
    const phases: Array<{ stage: string; message: string }> = [];
    client.onPhase((p) => phases.push(p));

    const loadPromise = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await loadPromise;

    // Engine-load phase is emitted synthetically on first load.
    expect(phases.some((p) => p.stage === 'engine-load')).toBe(true);

    const compilePromise = client.compile(compileRequest());
    await flush();
    expect(lastSent().method).toBe('compile');

    // A print carrying a pass marker becomes a parsed phase event.
    childState.emit?.({
      type: 'event',
      event: 'print',
      data: { line: '$ busytex pdflatex main.tex' },
    });
    expect(phases.some((p) => p.stage === 'pass')).toBe(true);

    respondOk({ exitCode: 0, pdfPath: '/tmp/out/main.pdf', log: '' });
    const result = await compilePromise;
    expect(result.exitCode).toBe(0);
  });

  it('sends at most one load when two compiles race at startup', async () => {
    // Regression: two compiles fired back-to-back both saw `loaded === false`
    // and each sent a `load` request. The second importScripts re-declares the
    // pipeline's top-level classes and crashes the child with
    // "Identifier 'BusytexDataPackageResolver' has already been declared".
    const first = client.compile(compileRequest('a'));
    const second = client.compile(compileRequest('b'));
    await flush();

    const loadRequests = childState.sent.filter((m) => m.method === 'load');
    expect(loadRequests).toHaveLength(1);

    // Answer the shared load, then both compiles — by id, in wire order
    // (respondOk targets the last message, which is wrong with two pending).
    for (const msg of childState.sent) {
      const result =
        msg.method === 'load' ? { loaded: true } : { exitCode: 0, pdfPath: `/x.pdf`, log: '' };
      childState.emit?.({ type: 'response', id: String(msg.id), result });
      await flush();
    }

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });

  it('a load cancelled mid-flight does not poison the replacement process', async () => {
    // Regression: compile #1 starts a cold start; compile #2 (file switch)
    // cancels, killing the process while `load` is in flight. The stale load
    // promise used to survive the exit — every later compile awaited it and
    // hung until timeout, with the UI stuck on "Staging project files".
    const first = client.compile(compileRequest('first'));
    await flush();
    expect(lastSent().method).toBe('load');

    // Cancel while the cold start is still running → process killed.
    client.kill();
    await expect(first).rejects.toThrow(BUSYTEX_STOPPED_MESSAGE);

    // The next compile must refork, send a FRESH load, and complete.
    const second = client.compile(compileRequest('second'));
    await flush();
    expect(lastSent().method).toBe('load');
    respondOk({ loaded: true });
    await flush();
    respondOk({ exitCode: 0, pdfPath: '/second.pdf', log: '' });
    const result = await second;
    expect(result.exitCode).toBe(0);
  });

  it('does not resend load to the same process after a real load failure', async () => {
    // Regression: a genuine load failure (not a cancel) used to retry `load`
    // against the SAME still-alive process. importScripts already declared
    // that process's top-level classes on the first attempt, so the retry
    // re-ran it and crashed with "Identifier ... already been declared". The
    // real child self-terminates on a load failure (see busytex-process's
    // handleLoad catch) — simulated here via the exit event, exactly as
    // Electron would deliver it for a real process.exit(1).
    const first = client.ensureLoaded();
    await flush();
    expect(lastSent().method).toBe('load');
    const failedId = String(lastSent().id);

    childState.emit?.({
      type: 'response',
      id: failedId,
      error: { message: 'engine call timed out after 300000ms' },
    });
    // The response already settled `first` with the real error; exit is
    // just the child's self-cleanup arriving after the fact.
    childState.exit?.(1);
    await expect(first).rejects.toThrow('timed out');

    // The follow-up ensureLoaded() must refork a NEW process and send load
    // exactly once against it — never a second load at the burned process.
    const second = client.ensureLoaded();
    await flush();
    const loadRequests = childState.sent.filter((m) => m.method === 'load');
    expect(loadRequests).toHaveLength(1);
    respondOk({ loaded: true });
    await second;
  });

  it('reports an unintentional exit as a crash, not a cancellation', async () => {
    // Regression: every exit used to map to the neutral stopped message, so
    // a segfault/OOM mid-compile looked identical to the user pressing stop
    // — engine faults were invisible behind "cancelled".
    const load = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await load;

    const compilePromise = client.compile(compileRequest());
    await flush();
    expect(lastSent().method).toBe('compile');

    // The engine dies on its own — no kill()/release() was called.
    childState.exit?.(1);
    await expect(compilePromise).rejects.toThrow(/crashed/);
  });

  it('kills a spawned child that never reports ready and lets a retry refork', async () => {
    // Regression: a start timeout used to only reject, leaving the orphaned
    // child alive and untracked — the next attempt would fork a SECOND
    // engine alongside it.
    client.startTimeoutMs = 80;
    childState.autoReady = false;
    const first = client.compile(compileRequest());
    // The rejection lands ~80 ms in but the assertion waits ~160 ms — mark
    // the interim window as handled so Node's unhandled-rejection heuristic
    // doesn't flag it (the later await still asserts the real rejection).
    void first.catch(() => {});
    await flush();
    await new Promise((r) => setTimeout(r, 160));
    await expect(first).rejects.toThrow(/start timeout/);
    expect(childState.killed).toBeGreaterThanOrEqual(1);

    // A retry against a well-behaved child completes normally.
    childState.autoReady = true;
    const second = client.compile(compileRequest());
    await flush();
    expect(lastSent().method).toBe('load');
    respondOk({ loaded: true });
    await flush();
    respondOk({ exitCode: 0, pdfPath: '/x.pdf', log: '' });
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rejects pending compiles with the stopped message on kill', async () => {
    const loadPromise = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await loadPromise;

    const compilePromise = client.compile(compileRequest());
    await flush();
    expect(lastSent().method).toBe('compile');

    client.kill();
    await expect(compilePromise).rejects.toThrow(BUSYTEX_STOPPED_MESSAGE);
  });

  it('accepts a follow-up compile after kill respawns the process', async () => {
    const first = client.compile(compileRequest('first'));
    await flush();
    client.kill();
    await expect(first).rejects.toThrow(BUSYTEX_STOPPED_MESSAGE);

    // Next use reforks and reloads lazily: a fresh process receives a load
    // request before the compile.
    const second = client.compile(compileRequest('second'));
    await flush();
    expect(lastSent().method).toBe('load');
    respondOk({ loaded: true });
    await flush();
    respondOk({ exitCode: 0, pdfPath: '/x.pdf', log: '' });
    const result = await second;
    expect(result.exitCode).toBe(0);
  });
});

describe('BusyTexProcessClient — idle release', () => {
  // Real timers with a short window: the fake clock's state interacts with
  // module re-evaluation in ways that made advanceTimersByTime unreliable
  // across tests. A 120 ms window is deterministic with real timers.
  const IDLE_MS = 120;

  let getFreshClient: typeof getBusyTexProcessClient;
  let client: ReturnType<typeof getBusyTexProcessClient>;
  let releaseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Fresh singleton — see the resetModules rationale above.
    getBusyTexProcessClient().kill();
    vi.resetModules();
    ({ getBusyTexProcessClient: getFreshClient } = await import(
      '../../src/main/services/BusyTexProcessClient'
    ));
    client = getFreshClient();
    client.idleReleaseMs = IDLE_MS;
    releaseSpy = vi.spyOn(client, 'release');
  });

  afterEach(() => {
    client.kill();
    vi.restoreAllMocks();
  });

  it('releases the engine process after the idle window elapses', async () => {
    const load = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await load;
    expect(releaseSpy).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, IDLE_MS + 80));
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('defers the idle release while a compile is in flight', async () => {
    // A compile may run longer than one idle window (the request cap is
    // 600 s) — the release armed at load time must not kill it mid-flight.
    const load = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await load;

    const compilePromise = client.compile(compileRequest());
    await flush();

    // The idle window elapses with the compile still pending — no release.
    await new Promise((r) => setTimeout(r, IDLE_MS + 80));
    expect(releaseSpy).not.toHaveBeenCalled();

    respondOk({ exitCode: 0, pdfPath: '/x.pdf', log: '' });
    await compilePromise;

    // Quiescent again — the next full window releases.
    await new Promise((r) => setTimeout(r, IDLE_MS + 80));
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('re-arms the window on activity so an active session never releases', async () => {
    const load = client.ensureLoaded();
    await flush();
    respondOk({ loaded: true });
    await load;

    // Compiles spaced at half the window keep re-arming it.
    for (let round = 0; round < 3; round += 1) {
      await new Promise((r) => setTimeout(r, IDLE_MS / 2));
      const compile = client.compile(compileRequest(`round ${round}`));
      await flush();
      respondOk({ exitCode: 0, pdfPath: '/x.pdf', log: '' });
      await compile;
      expect(releaseSpy).not.toHaveBeenCalled();
    }

    // Once the writer stops for a full window, it releases.
    await new Promise((r) => setTimeout(r, IDLE_MS + 80));
    expect(releaseSpy).toHaveBeenCalled();
  });
});
