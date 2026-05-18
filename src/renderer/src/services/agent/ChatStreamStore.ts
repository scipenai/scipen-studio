/**
 * @file ChatStreamStore — accumulates per-turn streaming events into
 *   structured `ChatTurn`s for React consumption.
 *
 * Each `chat.send` produces a new `ChatTurn` keyed by `turn_id`. As deltas
 * arrive we mutate the turn in place and notify listeners. Components
 * subscribe via `useSyncExternalStore`-style snapshot reads.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { agentClient, type ThreadMessageDTO } from './AgentClientService';

/**
 * Per-thread snapshot persisted in memory. Holds the rendered history
 * `messages` plus the latest `currentTurn` so a quick switch-back doesn't
 * blink. Tool-call metadata in completed turns is intentionally not cached
 * — when the user comes back to a thread, prior tool inspection isn't
 * required for chat continuity.
 */
interface ThreadCacheEntry {
  messages: ChatMessage[];
  completedTurns: Map<string, ChatTurn>;
  /** Wall-clock of last activity; used to expire stale cache rows. */
  touchedAt: number;
}

export interface ChatTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd?: number;
}

export interface ChatTurn {
  turnId: string;
  /** Whether the turn has emitted any thinking text. */
  hasThinking: boolean;
  /** Concatenated thinking content (for thinking models). */
  thinkingText: string;
  /** Concatenated final assistant text. */
  text: string;
  /** Tool invocations during this turn (ordered). */
  toolCalls: Array<{
    toolCallId: string;
    tool: string;
    args: unknown;
    status: 'pending' | 'progress' | 'success' | 'error';
    message?: string;
    result?: string;
  }>;
  /** True until a `done` event arrives. */
  pending: boolean;
  /** Final reason if not pending. */
  doneReason?: 'completed' | 'cancelled' | 'error';
  /** Error payload if the turn ended with an error. */
  error?: { code: number; message: string; recoverable: boolean };
  /** Token usage (filled by `usage.update` event). */
  usage?: ChatTurnUsage;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** For assistant: links to the turn record. */
  turnId?: string;
  text: string;
  ts: number;
}

type Listener = () => void;

/** Soft cap on cached threads to bound memory; LRU-style eviction by touchedAt. */
const MAX_CACHED_THREADS = 20;

class ChatStreamStoreImpl {
  /** Active thread id (null until ChatSidebar calls setActiveThread). */
  private activeThreadId: string | null = null;
  /** Persisted message-level history (visible in chat list) for the active thread. */
  private messages: ChatMessage[] = [];
  /** Live in-flight turn — set when a chat.send is awaiting deltas. */
  private currentTurn: ChatTurn | null = null;
  /** All completed turn metadata for the active thread, keyed by id. */
  private completedTurns = new Map<string, ChatTurn>();
  /** Per-thread cache keyed by thread_id; swap into active state on switch. */
  private threadCache = new Map<string, ThreadCacheEntry>();

  private listeners = new Set<Listener>();
  private subscribed = false;

  /** Subscribe to deltas once (idempotent — first React mount kicks it off). */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    agentClient.onTurnDelta((evt) => this.handleTurnDelta(evt));
    agentClient.onUsageUpdate((evt) => this.handleUsage(evt));
    agentClient.onError((evt) => this.handleError(evt));
  }

  // ---- public read API ----

  subscribe(listener: Listener): () => void {
    this.ensureSubscribed();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getCurrentTurn(): ChatTurn | null {
    return this.currentTurn;
  }

  getTurn(turnId: string): ChatTurn | undefined {
    if (this.currentTurn?.turnId === turnId) return this.currentTurn;
    return this.completedTurns.get(turnId);
  }

  getActiveThreadId(): string | null {
    return this.activeThreadId;
  }

  // ---- public write API ----

  /**
   * Stash current thread state into the cache and swap to another. Caller
   * is responsible for loading messages into the new active thread (see
   * `replaceMessages`).
   *
   * No-op when `threadId === activeThreadId` so React effect double-fires
   * during StrictMode don't churn.
   */
  setActiveThread(threadId: string | null): void {
    if (this.activeThreadId === threadId) return;

    // Snapshot the outgoing thread (only if it had any content worth keeping).
    if (this.activeThreadId && (this.messages.length > 0 || this.completedTurns.size > 0)) {
      this.threadCache.set(this.activeThreadId, {
        messages: this.messages,
        completedTurns: new Map(this.completedTurns),
        touchedAt: Date.now(),
      });
      this.evictStaleCache();
    }

    this.activeThreadId = threadId;
    this.currentTurn = null;

    if (threadId && this.threadCache.has(threadId)) {
      const cached = this.threadCache.get(threadId)!;
      this.messages = cached.messages;
      this.completedTurns = new Map(cached.completedTurns);
      cached.touchedAt = Date.now();
    } else {
      this.messages = [];
      this.completedTurns.clear();
    }

    this.fire();
  }

  /**
   * Replace the visible message list — used after a thread switch when
   * `agentClient.getMessages` returned the history. Wire DTOs are mapped
   * to in-store `ChatMessage` shape.
   */
  replaceMessages(threadId: string, wireMessages: ThreadMessageDTO[]): void {
    // Defensive: ignore if the user already moved on to a different thread.
    if (this.activeThreadId !== threadId) return;

    this.messages = wireMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        text: m.text,
        ts: parseRfc3339OrNow(m.ts),
      }));
    this.fire();
  }

  /**
   * Drop a thread from the in-memory cache (e.g. after `deleteThread`).
   * Safe to call for non-cached ids.
   */
  forgetThread(threadId: string): void {
    this.threadCache.delete(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.messages = [];
      this.currentTurn = null;
      this.completedTurns.clear();
      this.fire();
    }
  }

  private evictStaleCache(): void {
    if (this.threadCache.size <= MAX_CACHED_THREADS) return;
    // Drop the least-recently-touched entries until we're back under the cap.
    const sorted = Array.from(this.threadCache.entries()).sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt
    );
    while (this.threadCache.size > MAX_CACHED_THREADS && sorted.length > 0) {
      const [tid] = sorted.shift()!;
      this.threadCache.delete(tid);
    }
  }

  /**
   * Record the user message and immediately begin a new pending turn.
   * Caller still needs to fire `agentClient.sendChat()` separately — this
   * just sets up UI state so renders see the user message before stream
   * lands.
   */
  beginUserTurn(turnId: string, content: string): void {
    this.messages = [
      ...this.messages,
      { role: 'user', text: content, ts: Date.now() },
    ];
    this.currentTurn = makeEmptyTurn(turnId);
    this.fire();
  }

  /**
   * Clear all in-store state including the per-thread cache. Used when the
   * SNACA session is closed (new project, sidecar restart).
   */
  reset(): void {
    this.activeThreadId = null;
    this.messages = [];
    this.currentTurn = null;
    this.completedTurns.clear();
    this.threadCache.clear();
    this.fire();
  }

  // ---- inbound delta handling ----

  private handleTurnDelta(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    const turn = this.acquireTurn(turnId);

    switch (evt.kind) {
      case 'text':
        turn.text += evt.text;
        break;
      case 'thinking':
        turn.thinkingText += evt.text;
        turn.hasThinking = true;
        break;
      case 'tool_use':
        turn.toolCalls.push({
          toolCallId: evt.tool_call_id,
          tool: evt.tool,
          args: evt.args,
          status: 'pending',
        });
        break;
      case 'tool_progress': {
        const tc = turn.toolCalls.find((t) => t.toolCallId === evt.tool_call_id);
        if (tc) {
          tc.status = 'progress';
          tc.message = evt.message;
        }
        break;
      }
      case 'tool_result': {
        const tc = turn.toolCalls.find((t) => t.toolCallId === evt.tool_call_id);
        if (tc) {
          tc.status = evt.ok ? 'success' : 'error';
          tc.result = evt.content;
        }
        break;
      }
      case 'done':
        turn.pending = false;
        turn.doneReason = evt.reason;
        // Materialize the assistant message into the persistent log.
        if (turn.text.trim().length > 0) {
          this.messages = [
            ...this.messages,
            { role: 'assistant', turnId, text: turn.text, ts: Date.now() },
          ];
        }
        // Move turn from "current" to "completed".
        this.completedTurns.set(turnId, turn);
        if (this.currentTurn?.turnId === turnId) {
          this.currentTurn = null;
        }
        break;
      case 'error':
        turn.error = {
          code: evt.code,
          message: evt.message,
          recoverable: evt.recoverable,
        };
        break;
      default:
        return;
    }
    this.fire();
  }

  private handleUsage(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    const turn = this.acquireTurn(turnId);
    const u = evt.cumulative ?? {};
    turn.usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cachedInputTokens: u.cached_input_tokens ?? 0,
      costUsd: u.cost_usd,
    };
    this.fire();
  }

  private handleError(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    const turn = this.acquireTurn(turnId);
    turn.error = {
      code: evt.code,
      message: evt.message,
      recoverable: !!evt.recoverable,
    };
    this.fire();
  }

  private acquireTurn(turnId: string): ChatTurn {
    if (this.currentTurn?.turnId === turnId) return this.currentTurn;
    let turn = this.completedTurns.get(turnId);
    if (!turn) {
      turn = makeEmptyTurn(turnId);
      this.currentTurn = turn;
    }
    return turn;
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}

function makeEmptyTurn(turnId: string): ChatTurn {
  return {
    turnId,
    hasThinking: false,
    thinkingText: '',
    text: '',
    toolCalls: [],
    pending: true,
  };
}

/** RFC3339 → epoch ms; falls back to "now" on parse failure. */
function parseRfc3339OrNow(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

export const chatStreamStore = new ChatStreamStoreImpl();
