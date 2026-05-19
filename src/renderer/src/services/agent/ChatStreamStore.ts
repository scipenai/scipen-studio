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
import {
  deleteTurnMetaForThread,
  loadTurnMetaForThread,
  saveTurnMeta,
  turnMetaKey,
  type TurnMetaRecord,
} from './TurnMetaStore';

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

export interface ChatProposalRecord {
  proposalId: string;
  /** Absolute path, forward-slash normalized. */
  file: string;
  hunkCount: number;
  /** Pending → user hasn't decided; accepted / rejected once they do. */
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ChatPlanFile {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  renameTo?: string;
  summary: string;
  status: 'pending' | 'in_progress' | 'done' | 'rejected' | 'failed';
}

export interface ChatPlan {
  /** When true, SNACA is waiting for an explicit `plan.confirm`. */
  awaiting: boolean;
  rationale: string;
  files: ChatPlanFile[];
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
  /** Edit proposals raised during this turn (host_applies path). */
  proposals: ChatProposalRecord[];
  /** Latest plan.update snapshot, if SNACA emitted one. */
  plan: ChatPlan | null;
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

  /**
   * Monotonic snapshot counter, bumped on every state mutation. Components
   * `useSyncExternalStore` on `getVersion()` so React re-renders whenever
   * anything changes — the store is free to keep mutating internal objects
   * (turn text, tool calls, proposal status) without immutable wrappers.
   * Without this, selectors that read sub-shapes whose reference doesn't
   * change (e.g. activeThreadId still null while turn.delta accumulates
   * into currentTurn.text) would skip the re-render, leaving stream
   * progress invisible until some unrelated state forced a paint.
   */
  private version = 0;

  private listeners = new Set<Listener>();
  private subscribed = false;

  /** Subscribe to deltas once (idempotent — first React mount kicks it off). */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    agentClient.onTurnDelta((evt) => this.handleTurnDelta(evt));
    agentClient.onUsageUpdate((evt) => this.handleUsage(evt));
    agentClient.onError((evt) => this.handleError(evt));
    agentClient.onEditPropose((evt) => this.handleEditPropose(evt));
    agentClient.onEditProposeComplete((evt) => this.handleEditProposeComplete(evt));
    agentClient.onPlanUpdate((evt) => this.handlePlanUpdate(evt));
    agentClient.onEditApplied((evt) => this.handleEditApplied(evt));
  }

  // ---- public read API ----

  subscribe(listener: Listener): () => void {
    this.ensureSubscribed();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot counter — read via useSyncExternalStore to trigger React
   *  re-renders on any state mutation. See `version` field doc. */
  getVersion(): number {
    return this.version;
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

  /**
   * Snapshot of every cached thread id (for thread-list views that want a
   * stable equality reference across re-renders). The set itself isn't
   * exposed — callers only need length / membership signals via
   * `useSyncExternalStore` so individual change events are sufficient.
   */
  hasCachedThread(threadId: string): boolean {
    return this.threadCache.has(threadId);
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
   * to in-store `ChatMessage` shape; the `turn_id` SNACA now bundles on
   * assistant messages becomes the key the local IndexedDB cache uses
   * to re-attach thinking trace / tool calls / proposals.
   *
   * Cache rehydration is fire-and-forget: the visible message list paints
   * immediately, and once IDB returns we splice the meta into
   * `completedTurns` and fire again so React picks up the richer cards.
   */
  replaceMessages(threadId: string, wireMessages: ThreadMessageDTO[]): void {
    // Defensive: ignore if the user already moved on to a different thread.
    if (this.activeThreadId !== threadId) return;

    this.messages = wireMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        turnId: m.turn_id,
        text: m.text,
        ts: parseRfc3339OrNow(m.ts),
      }));
    this.fire();
    void this.hydrateTurnMetaFromCache(threadId);
  }

  /**
   * Async splice: pull every cached TurnMeta for the thread, build
   * synthetic completed turns, fire so React re-renders the richer
   * cards. Tolerant of IDB errors (cache loss only degrades to "no
   * thinking / no tool cards on old turns" — never breaks chat).
   */
  private async hydrateTurnMetaFromCache(threadId: string): Promise<void> {
    let records: TurnMetaRecord[];
    try {
      records = await loadTurnMetaForThread(threadId);
    } catch {
      return;
    }
    // The user may have already moved on to a different thread while
    // IDB was loading; bail out so we don't pollute the active turn map.
    if (this.activeThreadId !== threadId || records.length === 0) return;
    for (const r of records) {
      // Don't overwrite a fresher in-memory turn (e.g. the one currently
      // streaming, or one accepted by markProposalResolved after hydrate).
      if (this.completedTurns.has(r.turnId)) continue;
      this.completedTurns.set(r.turnId, recordToCompletedTurn(r));
    }
    this.fire();
  }

  /**
   * Drop a thread from the in-memory cache (e.g. after `deleteThread`).
   * Also evict the IndexedDB rows for that thread so storage doesn't
   * grow unbounded after the user deletes long-running conversations.
   */
  forgetThread(threadId: string): void {
    this.threadCache.delete(threadId);
    void deleteTurnMetaForThread(threadId).catch(() => {
      /* cache eviction is best-effort */
    });
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.messages = [];
      this.currentTurn = null;
      this.completedTurns.clear();
      this.fire();
    }
  }

  /**
   * Called by `AgentEditProposalBridge` when the user finishes the diff
   * review. SNACA doesn't emit a dedicated reject event, so the bridge
   * owns this translation. `accepted` will usually be confirmed soon
   * after by `edit.applied` (which is idempotent here).
   */
  markProposalResolved(proposalId: string, status: 'accepted' | 'rejected'): void {
    for (const turn of this.iterAllTurns()) {
      const p = turn.proposals.find((p) => p.proposalId === proposalId);
      if (p) {
        p.status = status;
        this.fire();
        return;
      }
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
   * Record the user message and reserve a slot for the pending turn.
   *
   * RACE NOTE: SNACA spawns the LLM task the instant `chat.send` is
   * received and starts emitting `turn.delta` immediately. Those deltas
   * routinely arrive over the IPC bus BEFORE `sendChat`'s RPC reply
   * surfaces the turn_id back here. `handleTurnDelta` will have already
   * created a `currentTurn` via `acquireTurn` and accumulated text into
   * it; if we blindly overwrote with a fresh empty turn here, those
   * early deltas would be lost (visible symptom: "no reply shows up
   * until I close and re-open the window", because hydrateThread later
   * reads SNACA's persisted assistant message).
   *
   * Preserve the accumulated turn when its id matches.
   */
  beginUserTurn(turnId: string, content: string): void {
    this.messages = [
      ...this.messages,
      { role: 'user', text: content, ts: Date.now() },
    ];
    if (!this.currentTurn || this.currentTurn.turnId !== turnId) {
      this.currentTurn = makeEmptyTurn(turnId);
    }
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
        // Persist the rich meta (thinking / tool calls / proposals / plan
        // / usage) to IndexedDB so a future hydrate can re-attach it to
        // SNACA's bare ThreadMessage. Fire-and-forget — IDB failure only
        // costs us the cards next time, never breaks chat.
        if (this.activeThreadId) {
          void this.persistTurnMeta(this.activeThreadId, turn);
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

  /**
   * `edit.propose` (and `edit.propose.complete`) carry a turn_id, the file
   * path, and the hunk set. We surface a single record per proposal —
   * complete events update hunkCount, never duplicate.
   */
  private handleEditPropose(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    // P1 SNACA emits both a streaming intermediate and a final propose;
    // skip the intermediates so the card doesn't churn.
    if (evt?.streaming === true) return;
    this.upsertProposal(turnId, evt);
  }

  private handleEditProposeComplete(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    // `final_hunks` is the canonical post-stream shape; some emitters also
    // send the older `hunks` field.
    const hunks = (evt.final_hunks ?? evt.hunks ?? []) as unknown[];
    this.upsertProposal(turnId, {
      proposal_id: evt.proposal_id,
      file: evt.file,
      hunks,
    });
  }

  private upsertProposal(turnId: string, evt: any): void {
    const proposalId = evt?.proposal_id as string | undefined;
    if (!proposalId) return;
    const file = (evt?.file as string | undefined) ?? '';
    const hunkCount = Array.isArray(evt?.hunks) ? evt.hunks.length : 0;
    const turn = this.acquireTurn(turnId);
    const existing = turn.proposals.find((p) => p.proposalId === proposalId);
    if (existing) {
      if (file) existing.file = file;
      if (hunkCount) existing.hunkCount = hunkCount;
    } else {
      turn.proposals.push({ proposalId, file, hunkCount, status: 'pending' });
    }
    this.fire();
  }

  /**
   * Host wrote the proposal to disk — flip the card to `accepted`. We have
   * no event for "rejected" yet (DiffReviewService swallows rejection
   * locally), so a still-pending card after the turn ends implies reject.
   */
  private handleEditApplied(evt: any): void {
    const proposalId = evt?.proposalId as string | undefined;
    if (!proposalId) return;
    for (const turn of this.iterAllTurns()) {
      const p = turn.proposals.find((p) => p.proposalId === proposalId);
      if (p) {
        p.status = 'accepted';
        this.fire();
        return;
      }
    }
  }

  private handlePlanUpdate(evt: any): void {
    const turnId = evt?.turn_id as string | undefined;
    if (!turnId) return;
    const turn = this.acquireTurn(turnId);
    turn.plan = {
      awaiting: !!evt.awaiting,
      rationale: (evt.rationale as string | undefined) ?? '',
      files: Array.isArray(evt.files)
        ? evt.files.map((f: any) => ({
            path: f.path,
            action: f.action,
            renameTo: f.rename_to,
            summary: f.summary,
            status: f.status,
          }))
        : [],
    };
    this.fire();
  }

  /** Iterate every known turn (current + completed) without allocating. */
  private *iterAllTurns(): Generator<ChatTurn> {
    if (this.currentTurn) yield this.currentTurn;
    for (const t of this.completedTurns.values()) yield t;
  }

  /** Snapshot `turn` into IDB. Only data the user would want to re-see
   *  on rehydrate gets stored (no `pending`/`doneReason`/`error` —
   *  those describe the live stream, not the persisted artifact). */
  private async persistTurnMeta(threadId: string, turn: ChatTurn): Promise<void> {
    try {
      await saveTurnMeta({
        key: turnMetaKey(threadId, turn.turnId),
        threadId,
        turnId: turn.turnId,
        thinking: turn.thinkingText,
        toolCalls: turn.toolCalls,
        proposals: turn.proposals,
        plan: turn.plan,
        usage: turn.usage,
        ts: Date.now(),
      });
    } catch {
      /* best-effort cache write */
    }
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
    this.version++;
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
    proposals: [],
    plan: null,
    pending: true,
  };
}

/**
 * Reconstruct a `ChatTurn` from an IDB record. The text part lives in the
 * SNACA-backed `ChatMessage` (which `ChatMessage` component pairs with
 * this turn via `turnId`), so the synthetic turn here is metadata-only.
 */
function recordToCompletedTurn(r: TurnMetaRecord): ChatTurn {
  return {
    turnId: r.turnId,
    hasThinking: r.thinking.length > 0,
    thinkingText: r.thinking,
    text: '', // canonical text comes from messages[], not the turn
    toolCalls: r.toolCalls,
    proposals: r.proposals,
    plan: r.plan,
    pending: false,
    doneReason: 'completed',
    usage: r.usage,
  };
}

/** RFC3339 → epoch ms; falls back to "now" on parse failure. */
function parseRfc3339OrNow(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

export const chatStreamStore = new ChatStreamStoreImpl();
