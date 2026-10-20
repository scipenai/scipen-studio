/**
 * @file busytex-process/workerBridge.ts — request/reply bridge to the worker script
 *
 * The vendored worker talks through `postMessage` / `onmessage` as if it ran
 * in a Web Worker. Here it shares this process's VM context, so the bridge
 * routes its frames: `print` lines stream out through a listener, and the
 * first terminal frame settles the single pending call.
 */

import { browserGlobals } from './browserShims';

let printListener: ((line: string) => void) | null = null;
let pendingFrame: ((frame: Record<string, unknown>) => void) | null = null;

export function setPrintListener(listener: ((line: string) => void) | null): void {
  printListener = listener;
}

/**
 * Route a frame emitted by the worker. `print` frames stream out as events;
 * the first terminal frame (initialized / exception / compile result) settles
 * the pending call.
 */
function onWorkerFrame(frame: Record<string, unknown>): void {
  if (frame.print !== undefined) {
    printListener?.(String(frame.print));
    return;
  }
  if (
    frame.exception !== undefined ||
    frame.initialized !== undefined ||
    frame.exit_code !== undefined ||
    frame.pdf !== undefined
  ) {
    const settle = pendingFrame;
    pendingFrame = null;
    settle?.(frame);
  }
}

/** The worker script installs `onmessage` at import time; drive it here. */
function workerPost(frame: Record<string, unknown>): void {
  void Promise.resolve(browserGlobals.onmessage?.({ data: frame })).catch((err: unknown) => {
    // Surface async exceptions from the worker's handler as a terminal frame
    // so a pending call cannot hang past the failure.
    pendingFrame?.({ exception: err instanceof Error ? err.stack : String(err) });
    pendingFrame = null;
  });
}

/** Send a frame into the worker and wait for its terminal reply. */
export function workerCall(
  frame: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // The worker script has a single pending-call slot: a second concurrent
    // call would clobber pendingFrame — the first caller would hang to its
    // timeout and print/phase attribution would cross between the two. The
    // renderer serializes compiles, but the wire defends itself regardless.
    if (pendingFrame) {
      reject(new Error('engine busy — another call is in flight'));
      return;
    }
    const timer = setTimeout(() => {
      pendingFrame = null;
      reject(new Error(`engine call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingFrame = (settled) => {
      clearTimeout(timer);
      if (settled.exception) {
        reject(new Error(String(settled.exception)));
        return;
      }
      resolve(settled);
    };
    workerPost(frame);
  });
}

export function installWorkerBridge(): void {
  // The worker script posts every frame through `postMessage`; route them into
  // the host (prints → events, terminal frames → pending call).
  browserGlobals.postMessage = (msg: Record<string, unknown>): void => {
    onWorkerFrame(msg);
  };

  // Safety net: the pipeline's init chain stores floating promises with no
  // catch (e.g. on_initialized_promise.then(on_initialized)), so a rejected
  // internal step NEVER reaches the worker's try/catch — it used to hang the
  // load handshake silently until timeout. Route unhandled rejections into
  // the pending call as a terminal exception frame instead.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error('[busytex-process] unhandled rejection:', message);
    if (pendingFrame) {
      const settle = pendingFrame;
      pendingFrame = null;
      settle({ exception: message });
    }
  });
}
