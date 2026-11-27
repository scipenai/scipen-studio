/**
 * @file busytex-process/hostChannel.ts — the utility process's link to main
 *
 * Electron exposes `process.parentPort` only inside a UtilityProcess; tests
 * install a stand-in before importing the entry. Resolved on every call so a
 * port installed after this module loaded is still honoured.
 */

import type { MessagePortMain } from 'electron';

interface ParentPort {
  postMessage(message: unknown): void;
  on(
    event: 'message',
    listener: (messageEvent: { data: unknown; ports: MessagePortMain[] }) => void
  ): void;
  on(event: 'close', listener: () => void): void;
}

function parentPort(): ParentPort | undefined {
  return (process as unknown as { parentPort?: ParentPort }).parentPort;
}

/** Post a message to the main process (the utility's only outbound channel). */
export function sendToParent(msg: Record<string, unknown>): void {
  parentPort()?.postMessage(msg);
}

/** Unsolicited event stream (prints, phases) — not tied to a request id. */
export function emitEvent(event: string, data: Record<string, unknown>): void {
  sendToParent({ type: 'event', event, data });
}

export function onParentMessage(listener: (data: Record<string, unknown>) => void): void {
  parentPort()?.on('message', (event) => listener(event.data as Record<string, unknown>));
}

export function onParentClose(listener: () => void): void {
  parentPort()?.on('close', listener);
}
