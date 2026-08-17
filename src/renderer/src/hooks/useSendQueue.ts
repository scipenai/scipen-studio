/**
 * @file useSendQueue — FIFO queue for chat messages typed while a turn is
 *       already in flight. Parallels codex-rs's `queued_user_messages`
 *       VecDeque; kept as a ref-backed hook (not a store) because the
 *       queue is UI-interaction state, not chat data, and doesn't need
 *       cross-component sharing.
 *
 * Model: SNACA sessions have a single-slot inflight turn (deliberate;
 * concurrent tool-call + edit-propose interleavings break UX). The UI
 * therefore queues additional user submissions and drains them one at a
 * time as the current turn completes — "post-turn FIFO" in codex terms.
 * Enter is smart-routed: idle → send, busy → enqueue.
 *
 * The state mirror (`items`) exists so React can re-render the chip UI;
 * the ref (`itemsRef`) is the authoritative source for handlers to read
 * without capturing stale closures.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

export interface QueuedMessage<TIntent extends string = string> {
  id: string;
  text: string;
  intent: TIntent;
  queuedAt: number;
}

export interface UseSendQueueOptions {
  /** Hard cap; enqueue past this returns false without pushing. */
  maxSize?: number;
}

export interface UseSendQueueReturn<TIntent extends string> {
  /** Current items in FIFO order (state — safe for render). */
  items: QueuedMessage<TIntent>[];
  /**
   * Rendered-snapshot size. Derived from the state mirror, so within a single
   * synchronous batch of enqueue/dequeue calls this may lag itemsRef by one
   * commit; use `enqueue`'s null return for authoritative "did it fit?".
   */
  size: number;
  /** Render-snapshot fullness; same lag caveat as `size`. */
  isFull: boolean;
  /** Enqueue; returns the new entry, or null if the queue is full. */
  enqueue: (text: string, intent: TIntent) => QueuedMessage<TIntent> | null;
  /** Pop the head; returns the item or null if empty. */
  dequeue: () => QueuedMessage<TIntent> | null;
  /** Remove one item by id (used by chip UI × button). */
  remove: (id: string) => void;
  /** Drop everything; returns the size at clear time so callers can log. */
  clear: () => number;
}

const DEFAULT_MAX = 20;

// Module-scope monotonic counter for the non-crypto fallback. Two enqueues
// within the same millisecond produced by Date.now+Math.random can collide
// (small but non-zero); a colliding id would make remove(id) drop both
// entries. The counter removes the risk entirely at negligible cost.
let fallbackIdSeq = 0;

function makeId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  fallbackIdSeq += 1;
  return `q_${Date.now().toString(36)}_${fallbackIdSeq.toString(36)}`;
}

export function useSendQueue<TIntent extends string = string>(
  options: UseSendQueueOptions = {}
): UseSendQueueReturn<TIntent> {
  const maxSize = options.maxSize ?? DEFAULT_MAX;
  // Ref is the source of truth (readable synchronously from event handlers
  // without stale-closure risk); state mirror drives re-renders for the
  // chip UI. Every mutation updates both — a small cost that beats letting
  // callers reason about two divergent representations.
  const itemsRef = useRef<QueuedMessage<TIntent>[]>([]);
  const [items, setItems] = useState<QueuedMessage<TIntent>[]>([]);

  const enqueue = useCallback(
    (text: string, intent: TIntent): QueuedMessage<TIntent> | null => {
      if (itemsRef.current.length >= maxSize) return null;
      const entry: QueuedMessage<TIntent> = {
        id: makeId(),
        text,
        intent,
        queuedAt: Date.now(),
      };
      itemsRef.current = [...itemsRef.current, entry];
      setItems(itemsRef.current);
      return entry;
    },
    [maxSize]
  );

  const dequeue = useCallback((): QueuedMessage<TIntent> | null => {
    if (itemsRef.current.length === 0) return null;
    const [head, ...rest] = itemsRef.current;
    itemsRef.current = rest;
    setItems(rest);
    return head;
  }, []);

  const remove = useCallback((id: string): void => {
    const next = itemsRef.current.filter((it) => it.id !== id);
    if (next.length === itemsRef.current.length) return;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const clear = useCallback((): number => {
    const size = itemsRef.current.length;
    if (size === 0) return 0;
    itemsRef.current = [];
    setItems([]);
    return size;
  }, []);

  // Memoize the return so its identity stays stable across renders. Consumers
  // put the whole return in dep arrays (drain useEffect, handleSend
  // useCallback); a fresh literal on every render would recreate handleSend
  // and re-run the drain effect on every streaming-token render — the
  // prevBusyRef guard neutralizes correctness impact, but the extra work is
  // wasted and shows up in profiles under heavy streaming.
  return useMemo(
    () => ({
      items,
      size: items.length,
      isFull: items.length >= maxSize,
      enqueue,
      dequeue,
      remove,
      clear,
    }),
    [items, maxSize, enqueue, dequeue, remove, clear]
  );
}
