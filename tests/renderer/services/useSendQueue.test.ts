/**
 * @file useSendQueue.test — FIFO invariants + maxSize cap + clear/remove
 *       semantics for the chat-send queue hook.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSendQueue } from '../../../src/renderer/src/hooks/useSendQueue';

describe('useSendQueue', () => {
  it('enqueues and dequeues in FIFO order', () => {
    const { result } = renderHook(() => useSendQueue<string>());
    act(() => {
      result.current.enqueue('a', 'chat');
      result.current.enqueue('b', 'chat');
      result.current.enqueue('c', 'chat');
    });
    expect(result.current.items.map((it) => it.text)).toEqual(['a', 'b', 'c']);
    expect(result.current.size).toBe(3);

    let popped: string | null = null;
    act(() => {
      popped = result.current.dequeue()?.text ?? null;
    });
    expect(popped).toBe('a');
    expect(result.current.items.map((it) => it.text)).toEqual(['b', 'c']);
  });

  it('honors maxSize and returns null past the cap', () => {
    const { result } = renderHook(() => useSendQueue<string>({ maxSize: 2 }));
    act(() => {
      expect(result.current.enqueue('a', 'chat')).not.toBeNull();
      expect(result.current.enqueue('b', 'chat')).not.toBeNull();
      expect(result.current.enqueue('c', 'chat')).toBeNull();
    });
    expect(result.current.size).toBe(2);
    expect(result.current.isFull).toBe(true);
  });

  it('remove drops a specific id and preserves order of the rest', () => {
    const { result } = renderHook(() => useSendQueue<string>());
    let ids: string[] = [];
    act(() => {
      ids = ['a', 'b', 'c', 'd'].map((t) => result.current.enqueue(t, 'chat')!.id);
    });
    act(() => {
      result.current.remove(ids[1]);
    });
    expect(result.current.items.map((it) => it.text)).toEqual(['a', 'c', 'd']);
  });

  it('remove of unknown id is a no-op (no state churn)', () => {
    const { result } = renderHook(() => useSendQueue<string>());
    act(() => {
      result.current.enqueue('a', 'chat');
    });
    const before = result.current.items;
    act(() => {
      result.current.remove('nonexistent');
    });
    // Same reference — no re-render triggered.
    expect(result.current.items).toBe(before);
  });

  it('clear returns the prior size and empties the queue', () => {
    const { result } = renderHook(() => useSendQueue<string>());
    act(() => {
      result.current.enqueue('a', 'chat');
      result.current.enqueue('b', 'chat');
    });
    let cleared = -1;
    act(() => {
      cleared = result.current.clear();
    });
    expect(cleared).toBe(2);
    expect(result.current.size).toBe(0);
    // Clearing an already-empty queue reports 0 without a spurious update.
    act(() => {
      cleared = result.current.clear();
    });
    expect(cleared).toBe(0);
  });

  it('dequeue on empty returns null', () => {
    const { result } = renderHook(() => useSendQueue<string>());
    let popped: unknown = 'unset';
    act(() => {
      popped = result.current.dequeue();
    });
    expect(popped).toBeNull();
  });
});
