/**
 * @file ChatStreamStore.test.ts — verifies per-thread cache + replaceMessages
 *   semantics introduced in P4-A.
 *
 * The store is a module-level singleton so we reset() between cases to
 * keep tests independent. We avoid hitting `agentClient` by never calling
 * `subscribe()` (which would lazy-bind to IPC listeners); instead we
 * exercise the cache surface directly.
 */

import { afterEach, describe, expect, it } from 'vitest';

// Stub the agentClient module before importing the store — the store's
// ensureSubscribed hooks into preload-bound listeners we don't want to
// touch in vitest.
import { vi } from 'vitest';
vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: {
    onTurnDelta: () => () => {},
    onUsageUpdate: () => () => {},
    onError: () => () => {},
  },
}));

import { chatStreamStore } from '../../../src/renderer/src/services/agent/ChatStreamStore';
import type { ThreadMessageDTO } from '../../../src/renderer/src/services/agent/AgentClientService';

afterEach(() => {
  chatStreamStore.reset();
});

describe('ChatStreamStore — per-thread cache', () => {
  it('setActiveThread tracks the active id and clears unrelated state', () => {
    chatStreamStore.setActiveThread('thread-a');
    expect(chatStreamStore.getActiveThreadId()).toBe('thread-a');
    expect(chatStreamStore.getMessages()).toEqual([]);
  });

  it('switching threads preserves outgoing messages in the cache', () => {
    const wireA: ThreadMessageDTO[] = [
      { role: 'user', text: 'hello A', ts: new Date().toISOString() },
      { role: 'assistant', text: 'hi from A', ts: new Date().toISOString() },
    ];
    chatStreamStore.setActiveThread('thread-a');
    chatStreamStore.replaceMessages('thread-a', wireA);
    expect(chatStreamStore.getMessages()).toHaveLength(2);

    // Switch to a fresh thread — store becomes empty.
    chatStreamStore.setActiveThread('thread-b');
    expect(chatStreamStore.getMessages()).toEqual([]);

    // Back to thread-a — cached messages should be restored without RPC.
    chatStreamStore.setActiveThread('thread-a');
    expect(chatStreamStore.getMessages()).toHaveLength(2);
    expect(chatStreamStore.getMessages()[0].text).toBe('hello A');
  });

  it('replaceMessages ignores stale wire updates for non-active threads', () => {
    chatStreamStore.setActiveThread('thread-a');
    chatStreamStore.replaceMessages('thread-b', [
      { role: 'user', text: 'oops', ts: new Date().toISOString() },
    ]);
    expect(chatStreamStore.getMessages()).toEqual([]);
  });

  it('replaceMessages drops system-role wire entries', () => {
    chatStreamStore.setActiveThread('thread-a');
    chatStreamStore.replaceMessages('thread-a', [
      { role: 'system', text: 'irrelevant', ts: new Date().toISOString() },
      { role: 'user', text: 'kept', ts: new Date().toISOString() },
    ]);
    const msgs = chatStreamStore.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });

  it('forgetThread evicts the cache row and clears active state if it matches', () => {
    chatStreamStore.setActiveThread('thread-a');
    chatStreamStore.replaceMessages('thread-a', [
      { role: 'user', text: 'goodbye', ts: new Date().toISOString() },
    ]);
    chatStreamStore.forgetThread('thread-a');
    expect(chatStreamStore.getActiveThreadId()).toBeNull();
    expect(chatStreamStore.getMessages()).toEqual([]);
  });

  it('forgetThread for a non-active thread only evicts the cache', () => {
    chatStreamStore.setActiveThread('thread-a');
    chatStreamStore.replaceMessages('thread-a', [
      { role: 'user', text: 'a-msg', ts: new Date().toISOString() },
    ]);
    chatStreamStore.setActiveThread('thread-b');
    // thread-a is now cached; thread-b is active.
    chatStreamStore.forgetThread('thread-a');
    expect(chatStreamStore.getActiveThreadId()).toBe('thread-b');
    // Switching back must NOT restore — cache was evicted.
    chatStreamStore.setActiveThread('thread-a');
    expect(chatStreamStore.getMessages()).toEqual([]);
  });

  it('parses RFC3339 timestamps and falls back to "now" on garbage', () => {
    chatStreamStore.setActiveThread('thread-a');
    const garbageTs = 'not-a-date';
    const before = Date.now();
    chatStreamStore.replaceMessages('thread-a', [
      { role: 'user', text: 'msg', ts: garbageTs },
    ]);
    const after = Date.now();
    const ts = chatStreamStore.getMessages()[0].ts;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
