/**
 * @file ChatSidebar - the right-rail chat panel (Ctrl+L surface).
 *
 * P4 scope:
 *  - On mount, calls `agent.startProject(workspaceRoot)` once per workspace
 *    root. The result seeds the thread list + active thread id.
 *  - Header surfaces the current thread title (click to open history drawer),
 *    a "+" new-thread button, and the connection badge.
 *  - ThreadHistoryDrawer lists every thread; switch / new / rename / delete
 *    all flow through `agentClient` + `chatStreamStore` here.
 *  - Per-thread message cache lives in `chatStreamStore`; switch fetches
 *    history only when the cache misses, so flipping between recently-used
 *    threads is instant.
 *
 *  - Delete fallback (matches main-side `Agent_DeleteThread`): main returns
 *    the post-delete `activeThreadId` (most-recently-active or freshly
 *    spawned). We trust that value rather than re-listing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Bot, Check, Copy, History, MessageCircleQuestion, Plus, Settings2 } from 'lucide-react';
import type React from 'react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useEvent } from '../../hooks';
import { useSendQueue } from '../../hooks/useSendQueue';
import { getLocale, t as translate, useTranslation, type TranslationKey } from '../../locales';
import { agentClient, type ThreadSummary } from '../../services/agent/AgentClientService';
import { buildChatContext } from '../../services/agent/ChatContextBuilder';
import { buildMentions } from '../../services/AtMentionResolver';
import { buildSelectionActionPrompt } from '../../services/agent/selectionActionPrompts';
import { api } from '../../api';
import { chatStreamStore } from '../../services/agent/ChatStreamStore';
import { getSettingsService, getUIService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { AGENT_NOT_CONFIGURED_MARKER } from '@shared/ipc/types';
import { ConfigKeys } from '@shared/types/config-keys';
import type {
  SelectionAction,
  SelectionActionRequest,
  UnifiedSelection,
} from '@shared/types/selection-action';
import type { AskAIAboutErrorRequest } from '../../services/core/UIService';
import { AgentChatInput, type SendIntent } from './AgentChatInput';
import { ChatMessage } from './ChatMessage';
import { SelectionActionCard } from './SelectionActionCard';
import { QueuedMessagesChip } from './QueuedMessagesChip';
import { ThreadHistoryDrawer } from './ThreadHistoryDrawer';
import { serializeChatThread } from '../../utils/serializeChatThread';

/**
 * Actions gated behind Zotero integration + the i18n key used to
 * explain WHY each is unavailable. Single source of truth so the runtime
 * click guard AND the per-action `disabledActions` reason map both derive
 * from the same table — adding a Zotero-gated action later means adding
 * one entry here, not editing two spots.
 */
const ZOTERO_GATED_REASON_KEYS = {
  find_related_lit_local: 'chat.selectionAction.zoteroNotConfigured',
} as const satisfies Partial<Record<SelectionAction, TranslationKey>>;
const ZOTERO_GATED_ACTIONS: ReadonlySet<SelectionAction> = new Set(
  Object.keys(ZOTERO_GATED_REASON_KEYS) as SelectionAction[]
);

/**
 * Wrap the plain text as a markdown blockquote for the composer seed, so
 * a `> ` prefix visually distinguishes injected material from what the
 * user is about to type. Empty input yields empty string (no quote noise).
 */
function quoteForSeed(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `> ${trimmed.replace(/\n/g, '\n> ')}\n\n` : '';
}

interface ChatSidebarProps {
  /** Absolute path of the current project root. Required for startProject. */
  workspaceRoot: string | null;
  /** Optional human-readable name surfaced in SNACA logs. */
  displayName?: string;
}

type StartupState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; sessionId: string }
  // 'needs-config' is the expected initial state, explicitly distinct from
  // runtime errors below: the former renders a guidance card (open Settings
  // and fill in the key), the latter is a red error banner. Determined by
  // the main process (see AGENT_NOT_CONFIGURED_MARKER).
  | { kind: 'needs-config' }
  | { kind: 'error'; message: string };

/**
 * Per-project startProject cache (module-level, survives component remounts).
 * After main-page panel layout switched to declarative conditional rendering,
 * collapsing chat unmounts ChatSidebar and expanding remounts it — this cache
 * lets the remount restore local UI (startup/threads) without re-running
 * startProject or resetting an existing session. chatStreamStore is already a
 * module-level singleton, so messages keep accumulating during unmount and
 * display on remount as expected.
 */
const startedProjects = new Map<string, { sessionId: string; threads: ThreadSummary[] }>();

/**
 * SNACA's `session.new_thread` returns a non-empty sentinel title when the
 * caller doesn't supply one (`snaca_editor::session_manager::DEFAULT_THREAD_TITLE`).
 * Renderer-side we want "no user-assigned title" to read as untitled — both
 * to (a) actually trigger the LLM-driven topic summarization on the first
 * user message, and (b) render the localized placeholder in the header
 * rather than the English sentinel on a Chinese UI. Centralizing the check
 * keeps the two surfaces in lockstep.
 */
const SNACA_DEFAULT_THREAD_TITLE = 'New conversation';
function isUntitledThread(title: string | null | undefined): boolean {
  return !title || title === SNACA_DEFAULT_THREAD_TITLE;
}

/** Derive a fallback title from the user's first message (used when the LLM is
 * unavailable or fails): take the first line, strip quotes/attachment markers/
 * markdown, then truncate. */
function deriveTitleFromText(text: string): string {
  const firstLine =
    text
      .replace(/^\s*>+\s?/gm, '')
      .replace(/\[attached:[^\]]*\]/gi, '')
      .replace(/[`*#_~]+/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

function ChatSidebarInner({ workspaceRoot, displayName }: ChatSidebarProps): React.ReactElement {
  const { t } = useTranslation();
  const chatFontSize = useSettings((s) => s.ui.chatFontSize);
  const [startup, setStartup] = useState<StartupState>({ kind: 'idle' });
  // Let the one-shot AI-config listener read the latest startup state without
  // putting `startup` in its dependency list (which would cause it to resubscribe).
  const startupRef = useRef<StartupState>(startup);
  startupRef.current = startup;
  // Auto-retry trigger: bumping this lets the start effect re-run (the startedFor guard resets).
  const [retryNonce, setRetryNonce] = useState(0);
  // Pending auto-retry timer: typing a key character by character triggers a
  // burst of config changes — keep only the last one.
  const retryTimerRef = useRef<number | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // Hand handleSend the latest threads snapshot without listing `threads`
  // among its deps (which would cause frequent rebuilds).
  const threadsRef = useRef<ThreadSummary[]>(threads);
  threadsRef.current = threads;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [seedValue, setSeedValue] = useState<string | undefined>(undefined);
  const [seedKey, setSeedKey] = useState<number>(0);
  const [pendingSelection, setPendingSelection] = useState<UnifiedSelection | null>(null);
  // null = not-yet-loaded; only surface the "Zotero not configured" gate
  // when we KNOW it's off. Starting at `false` gave a false-negative
  // disabled state during the mount → first api.config.get resolves gap.
  const [zoteroEnabled, setZoteroEnabled] = useState<boolean | null>(null);
  const startedFor = useRef<string | null>(null);
  // Synchronous re-entrancy guard for handleSelectionAction. React state
  // (`busy`, `pendingSelection`) updates asynchronously, so a rapid second
  // click landing in the same event batch would otherwise slip past the
  // guard before the first setState commits. A ref flips inside the
  // click's synchronous frame, so the second click sees the block.
  const selectionActionInFlight = useRef<boolean>(false);
  const uiService = useMemo(() => getUIService(), []);

  // Track Zotero master toggle so the SelectionActionCard can gate its
  // "find related literature" button. Subscribes to Config_Changed so a
  // user who opens the wizard while the sidebar is mounted sees the
  // button enable without needing to remount the panel.
  //
  // `seq` is a last-write-wins guard: back-to-back Config_Changed events
  // (or a change landing while the initial read is still in flight) fire
  // two concurrent api.config.get promises, and their resolution order is
  // NOT guaranteed — the older value could land last and mis-gate the
  // button until the next config change. Each invocation captures a fresh
  // seq id and only writes state when that id is still the newest.
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const applyEnabled = async (): Promise<void> => {
      const mySeq = ++seq;
      try {
        const enabled = await api.config.get<boolean>(ConfigKeys.ZoteroIntegrationEnabled);
        if (!cancelled && mySeq === seq) setZoteroEnabled(Boolean(enabled));
      } catch {
        // Read failure = unknown, NOT "off". The disable-gate policy is
        // "only surface when we KNOW it's off"; treating a transient IPC
        // fault as off would gate the button and lie to the user. null
        // matches the loading-state contract — let the tool call surface
        // the real state.
        if (!cancelled && mySeq === seq) setZoteroEnabled(null);
      }
    };
    void applyEnabled();
    const dispose = api.config.onChanged((payload) => {
      if (payload.key === ConfigKeys.ZoteroIntegrationEnabled) {
        void applyEnabled();
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // Subscribe to chatStreamStore's version counter. ANY internal mutation
  // (turn.delta accumulation, tool calls, proposals, active-thread swap,
  // history reload) bumps the version, so React re-renders and then reads
  // fresh snapshots from the direct getters below. Subscribing to a
  // sub-shape (e.g. activeThreadId alone) would skip re-renders for
  // streaming text since the thread id doesn't change mid-turn.
  useSyncExternalStore(
    (cb) => chatStreamStore.subscribe(cb),
    () => chatStreamStore.getVersion(),
    () => 0
  );

  const activeThreadId = chatStreamStore.getActiveThreadId();
  const messages = chatStreamStore.getMessages();
  const currentTurn = chatStreamStore.getCurrentTurn();
  const activeThread = useMemo(
    () => threads.find((th) => th.thread_id === activeThreadId) ?? null,
    [threads, activeThreadId]
  );

  // ---- thread RPC helpers ----

  const refreshThreads = useCallback(async () => {
    try {
      const list = await agentClient.listThreads();
      setThreads(list);
    } catch (err) {
      // Non-fatal: keep the stale list.
      console.warn('[ChatSidebar] listThreads failed', err);
    }
  }, []);

  const hydrateThread = useCallback(
    async (threadId: string) => {
      try {
        const { messages: wire } = await agentClient.getMessages(threadId);
        chatStreamStore.replaceMessages(threadId, wire);
      } catch (err) {
        setThreadError(`${t('thread.loadFailed')}: ${extractErrorMessage(err)}`);
      }
    },
    [t]
  );

  // Stick-to-bottom: follow new content only while the view is pinned near the
  // bottom; once the user scrolls up to read, stop yanking them back down.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useEffect(() => {
    if (!stick.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // rAF so layout has settled before we pin to the bottom (avoids fighting
    // the browser's scroll anchoring mid-stream).
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages.length, currentTurn?.text.length, currentTurn?.thinkingText.length]);
  // Switching threads always jumps to the latest.
  useEffect(() => {
    stick.current = true;
  }, [activeThreadId]);

  // Start (or re-attach to) the project session once the workspaceRoot is known.
  // Safe across remounts: if this root has already been started, only restore
  // local UI — do not call startProject again or reset an existing
  // chatStreamStore (so panel toggling never drops the conversation).
  useEffect(() => {
    if (!workspaceRoot) return;
    if (startedFor.current === workspaceRoot) return;
    startedFor.current = workspaceRoot;

    const cached = startedProjects.get(workspaceRoot);
    if (cached) {
      setStartup({ kind: 'ready', sessionId: cached.sessionId });
      setThreads(cached.threads);
      void refreshThreads();
      return;
    }

    setStartup({ kind: 'starting' });
    setThreadError(null);
    void agentClient
      .startProject(workspaceRoot, displayName)
      .then((res) => {
        startedProjects.set(workspaceRoot, { sessionId: res.sessionId, threads: res.threads });
        setStartup({ kind: 'ready', sessionId: res.sessionId });
        setThreads(res.threads);
        // Reset prior store before binding to the fresh session, then mirror
        // SNACA's active thread choice into the store (the single source of
        // truth for activeThreadId on the renderer side).
        chatStreamStore.reset();
        if (res.threadId) {
          chatStreamStore.setActiveThread(res.threadId);
          // Eagerly load history for the active thread; ignore errors —
          // sidecar may not yet support get_messages on older binaries.
          void hydrateThread(res.threadId);
        }
      })
      .catch((err) => {
        const message = extractErrorMessage(err);
        // `includes` (not strict equality): Electron prefixes cross-process
        // Error.message with "Error invoking remote method '…':", sandwiching
        // the marker in the middle.
        if (message.includes(AGENT_NOT_CONFIGURED_MARKER)) {
          setStartup({ kind: 'needs-config' });
        } else {
          setStartup({ kind: 'error', message });
        }
      });
  }, [workspaceRoot, displayName, retryNonce, refreshThreads, hydrateThread]);

  // Auto-recover after the user fills in an API key: when AI config changes
  // while we are stuck on 'needs-config', clear this project's start guard
  // and bump retryNonce so the start effect re-runs above. Delay 500ms
  // (debounced, keep only the last fire) so the main-side debounced (300ms)
  // sidecar restart lands first — main owns sidecar lifecycle, we wait
  // until it stabilises before retrying.
  useEffect(() => {
    const settings = getSettingsService();
    const disposable = settings.onDidChangeAIProviders(() => {
      if (startupRef.current.kind !== 'needs-config' || !workspaceRoot) return;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (startupRef.current.kind !== 'needs-config') return;
        startedFor.current = null;
        setRetryNonce((n) => n + 1);
      }, 500);
    });
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      disposable.dispose();
    };
  }, [workspaceRoot]);

  // ---- inbound prompt injection (Ask-AI buttons → input seed) ----

  useEvent(
    uiService.onDidRequestAIErrorAnalysis,
    (req: AskAIAboutErrorRequest) => {
      setSeedValue(formatErrorPrompt(req));
      setSeedKey((k) => k + 1);
      // Drain the cached copy on live delivery so a subsequent hide → show
      // cycle doesn't replay the same error prompt.
      uiService.consumePendingAIErrorAnalysis();
    },
    []
  );

  useEvent(
    uiService.onDidRequestChatWithText,
    ({ text }) => {
      setSeedValue(quoteForSeed(text));
      setSeedKey((k) => k + 1);
      // Same drain-on-live-delivery pattern as above.
      uiService.consumePendingChatWithText();
    },
    []
  );

  useEvent(
    uiService.onDidRequestSelectionAction,
    (request: SelectionActionRequest) => {
      setPendingSelection(request.selection);
      // UIService writes the cache BEFORE firing so a request made while
      // this panel is unmounted still lands on the next mount's drain.
      // When we're mounted (this handler runs), consume the cache so a
      // subsequent hide → show cycle cannot resurrect a card the user
      // already dismissed or completed.
      uiService.consumePendingSelectionAction();
    },
    []
  );

  // Drain any request that fired while ChatSidebar was unmounted (chat
  // panel hidden at fire time, or the useEvent binding hadn't attached
  // yet). UIService caches the last request per channel so the very
  // first paint after unhiding still sees the trigger.
  useEffect(() => {
    const pendingSelectionReq = uiService.consumePendingSelectionAction();
    if (pendingSelectionReq) setPendingSelection(pendingSelectionReq.selection);

    const pendingErrorReq = uiService.consumePendingAIErrorAnalysis();
    if (pendingErrorReq) {
      setSeedValue(formatErrorPrompt(pendingErrorReq));
      setSeedKey((k) => k + 1);
    }

    const pendingChatReq = uiService.consumePendingChatWithText();
    if (pendingChatReq) {
      setSeedValue(quoteForSeed(pendingChatReq.text));
      setSeedKey((k) => k + 1);
    }
  }, [uiService]);

  // ---- send / cancel ----

  const busy = currentTurn?.pending === true;

  // FIFO queue for messages typed while a turn is in flight. SNACA rejects
  // concurrent turns (per-session single-slot inflight, deliberate),
  // so the UI queues and drains one turn at a time — "post-turn FIFO",
  // borrowed from codex-rs's queued_user_messages. See useSendQueue for
  // the ref+state mirror rationale.
  const sendQueue = useSendQueue<SendIntent>();

  // After the first user message in a new thread, generate a topic title via
  // the completion model; fall back to the leading-line extract on failure
  // or when LLM is not configured. Only fires when the thread has no title;
  // user-renamed threads are never overwritten.
  const autoGenerateTitle = useCallback(
    async (threadId: string, userText: string) => {
      let title = deriveTitleFromText(userText);
      try {
        const res = await api.ai.generateTitle(userText);
        if (res.success && res.content?.trim()) {
          title = res.content.trim().slice(0, 24);
        }
      } catch {
        // Keep the fallback title.
      }
      if (!title) return;
      setThreads((prev) => prev.map((th) => (th.thread_id === threadId ? { ...th, title } : th)));
      try {
        await agentClient.renameThread(threadId, title);
        void refreshThreads();
      } catch {
        // Server-side rename failure does not affect the local display.
      }
    },
    [refreshThreads]
  );

  const handleSend = useCallback(
    async (
      text: string,
      intent: SendIntent,
      opts?: {
        skipMentions?: boolean;
        titleSeed?: string;
        /**
         * Set by the drain useEffect when replaying a queued message. Callers
         * never set this; it bypasses the busy → queue gate so a message
         * pulled off the queue actually reaches the wire instead of being
         * re-enqueued in a loop.
         */
        fromQueue?: boolean;
      }
    ): Promise<{ sent: boolean; error?: string }> => {
      // Queue gate: if a turn is currently in flight and this send is not
      // a drain replay, park the message rather than reject the click. The
      // drain effect below flushes the head as soon as `busy` flips false.
      // Startup errors still hard-reject — no point queueing when the
      // service isn't up.
      if (busy && !opts?.fromQueue) {
        if (startup.kind !== 'ready') {
          return { sent: false, error: startup.kind === 'error' ? startup.message : undefined };
        }
        const entry = sendQueue.enqueue(text, intent);
        if (!entry) {
          // Queue full. AgentChatInput.submit() calls onSend and then
          // unconditionally clears the textarea (its onSend signature is
          // fire-and-forget), so relying on the returned error alone would
          // silently discard the typed text. Surface via threadError so
          // both selection-card and composer paths get user-visible feedback.
          const fullError = t('chat.queue.full');
          setThreadError(fullError);
          return { sent: false, error: fullError };
        }
        // From the caller's perspective the submission was accepted;
        // selection-action UX treats this the same as a live send (card
        // clears, composer resets) since the queue owns delivery.
        return { sent: true };
      }
      // Decide before writing this turn: is this the first message in a
      // not-yet-titled thread?
      const titleThreadId = chatStreamStore.getActiveThreadId();
      const isFirstMessage = chatStreamStore.getMessages().length === 0;
      const existingThread = threadsRef.current.find((th) => th.thread_id === titleThreadId);
      const needsTitle = Boolean(
        isFirstMessage && titleThreadId && isUntitledThread(existingThread?.title)
      );
      try {
        const context = buildChatContext();
        // Resolve `@path` tokens into structured `Mention[]` so the LLM
        // receives the inline file content via SNACA's typed channel
        // rather than as opaque chat text. cleanedText keeps the user
        // message readable (tokens become `[attached: path]` markers).
        //
        // Selection-action turns opt out (`skipMentions`): the prompt wraps
        // the user's captured text in `<reference_material>` and any `@…`
        // tokens inside it are quoted material, not a request to attach a
        // project file. Running buildMentions on that text would silently
        // pull in matching project paths (e.g. main.tex from an external
        // paper's citation), leaking unrelated project files to the model.
        let payload = text;
        if (!opts?.skipMentions) {
          const { mentions, cleanedText } = await buildMentions(text, workspaceRoot);
          if (mentions.length > 0) {
            context.mentions = [...(context.mentions ?? []), ...mentions];
          }
          payload = cleanedText;
        }
        if (intent === 'composer') {
          const { turnId } = await agentClient.startComposer(payload, context, 'plan_first');
          chatStreamStore.beginComposerTurn(turnId, payload);
        } else {
          const { turnId } = await agentClient.sendChat(payload, context);
          chatStreamStore.beginUserTurn(turnId, payload);
        }
        void refreshThreads();
        if (needsTitle && titleThreadId) {
          // Selection-action turns pass a short titleSeed (action label +
          // short excerpt) because `text` is a 20K-char prompt starting
          // with the INJECTION_GUARD sentence — deriveTitleFromText's
          // first-line rule would otherwise name the thread after that
          // guard prefix. Regular text turns pass no seed; the raw text
          // stays authoritative.
          void autoGenerateTitle(titleThreadId, opts?.titleSeed ?? text);
        }
        return { sent: true };
      } catch (err) {
        const message = extractErrorMessage(err);
        setStartup({ kind: 'error', message });
        // Return the message so caller-side surfaces (selection card banner)
        // can distinguish a network fault from an agent-unavailable error
        // instead of showing the same generic "send failed" line.
        return { sent: false, error: message };
      }
    },
    [refreshThreads, workspaceRoot, autoGenerateTitle, busy, startup, sendQueue, t]
  );

  // Drain the send queue as turns complete. Edge-triggered on busy: true→false
  // so a stable busy state doesn't re-fire; isFlushingRef additionally guards
  // against StrictMode double-invocation. One item per completion; the next
  // send flips busy=true again which re-arms the edge for the item after.
  //
  // sendQueue is intentionally in the deps: its identity is stable per render
  // (useSendQueue memoizes its return), and referencing it directly avoids a
  // render-phase ref-mirror assignment (React anti-pattern under concurrent
  // rendering). The prevBusyRef edge guard already neutralizes any re-runs
  // triggered by identity drift.
  const prevBusyRef = useRef(false);
  const isFlushingRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    // Only advance the edge tracker after the gate checks pass — otherwise a
    // startup-not-ready run consumes the true→false edge and later drains
    // are skipped when startup recovers.
    if (!wasBusy || busy) {
      prevBusyRef.current = busy;
      return;
    }
    if (isFlushingRef.current) return;
    if (startup.kind !== 'ready') return; // do NOT advance prevBusyRef yet
    prevBusyRef.current = busy;
    const head = sendQueue.dequeue();
    if (!head) return;
    isFlushingRef.current = true;
    void handleSend(head.text, head.intent, { fromQueue: true })
      .then((res) => {
        // Replay failed before a new turn started (network fault, startup
        // flip, etc.). busy never rearms → without this branch the popped
        // message vanishes silently and the rest of the queue strands.
        // Surface via threadError; the remaining queue stays intact so the
        // user can decide whether to Cancel (wipe) or retry (re-send from
        // the composer, which uses the same drain path).
        if (!res.sent) {
          const detail = res.error ?? t('chat.sendFailed');
          setThreadError(detail);
        }
      })
      .finally(() => {
        isFlushingRef.current = false;
      });
  }, [busy, startup.kind, handleSend, sendQueue, t]);

  const handleCancel = useCallback(async () => {
    if (!currentTurn) return;
    // Clear BEFORE awaiting: busy is store-driven (finalizeTurn fires on the
    // stream 'done'/'error' event, which can beat the cancelTurn IPC roundtrip).
    // If the busy true→false edge fires while we're still awaiting, the drain
    // effect would pop and send the queue head — violating "cancel = full stop"
    // and misreporting the toast count. try/finally keeps the toast even if
    // the IPC rejects (otherwise the rejection escapes onClick unhandled and
    // the user sees the queue vanish with no explanation).
    const dropped = sendQueue.clear();
    try {
      await agentClient.cancelTurn(currentTurn.turnId);
    } finally {
      if (dropped > 0) {
        setThreadError(t('chat.queue.cancelled', { n: String(dropped) }));
      }
    }
  }, [currentTurn, sendQueue, t]);

  // Card owns only the "which action was clicked" decision. The full send
  // path (mentions, title generation, composer branch, error surfaces) stays
  // in handleSend so future changes there apply to selection-driven turns
  // automatically. Snapshot pendingSelection before clearing so a race with
  // dismiss can't drop the click mid-send.
  const handleSelectionAction = useCallback(
    async (action: SelectionAction) => {
      // Synchronous re-entrancy check first — see the `selectionActionInFlight`
      // ref definition above. React batches setState within a single event, so
      // a rapid second click can pass every state-derived guard until we flip
      // this synchronous flag.
      if (selectionActionInFlight.current) return;
      // Defensive guard mirrors the card's `disabled` prop. The card
      // already hides the click when startup!=ready or busy, but a stale
      // focus / keyboard-triggered click could still land here mid-send.
      if (busy || startup.kind !== 'ready') return;
      // Only block when we KNOW Zotero is disabled; null (loading) is
      // treated as "let the user try, tool call will surface the truth".
      if (ZOTERO_GATED_ACTIONS.has(action) && zoteroEnabled === false) return;
      const captured = pendingSelection;
      if (!captured) return;
      selectionActionInFlight.current = true;
      // Build the prompt BEFORE clearing the card. buildSelectionActionPrompt
      // can throw (default-case exhaustiveness assertion for IPC edge cases).
      // Route the error through the scoped `threadError` banner (NOT
      // `setStartup`) so the sidebar stays interactive and the card stays
      // visible + clickable — the user can retry the same action or pick
      // a different one without waiting for startup to reset.
      let prompt: string;
      try {
        prompt = buildSelectionActionPrompt(action, captured, getLocale());
      } catch (err) {
        selectionActionInFlight.current = false;
        setThreadError(extractErrorMessage(err));
        return;
      }
      // Snapshot the pre-send startup so a send failure inside handleSend
      // (which flips `startup` to 'error' via its own catch) can be rolled
      // back — otherwise the card stays visible but its buttons are
      // disabled by `busy || startup.kind !== 'ready'`, defeating the
      // whole "keep the card for one-click retry" design.
      const preSendStartup = startup;
      try {
        // skipMentions: the selection may contain `@…` tokens that must be
        // treated as quoted material, not as file-attachment hints. See the
        // handleSend body for the full rationale.
        //
        // titleSeed: pass a compact "<action label>: <first ~100 chars of
        // selection>" instead of the full prompt so autoGenerateTitle's
        // fallback doesn't name the thread after the INJECTION_GUARD
        // sentence — the first line of the raw prompt.
        //
        // Only clear the card on success. handleSend returns sent=false
        // when it caught an error internally (network fault, agent
        // unavailable) — recreating an external-app selection would require
        // the user to switch back to that app and reselect the text, so we
        // keep the card so retry is one click away.
        const actionLabel = t(
          `chat.selectionAction.actions.${
            action === 'find_related_lit_local' ? 'findRelatedLit' : action
          }` as TranslationKey
        );
        const titleSeed = `${actionLabel}: ${captured.text.slice(0, 100)}`;
        const { sent, error } = await handleSend(prompt, 'chat', {
          skipMentions: true,
          titleSeed,
        });
        if (sent) {
          // Setter form: if a NEW selection arrived while we were
          // awaiting, `pendingSelection` now points at the new one —
          // clearing it would silently drop the user's second attempt.
          setPendingSelection((prev) => (prev === captured ? null : prev));
        } else {
          // Roll back the sidebar-wide error state that handleSend set,
          // and surface the failure via the scoped threadError banner so
          // the card + composer stay enabled for immediate retry. Include
          // the underlying error so the user can tell "network down" from
          // "agent not configured".
          setStartup(preSendStartup);
          setThreadError(error ? `${t('chat.sendFailed')}: ${error}` : t('chat.sendFailed'));
        }
      } finally {
        selectionActionInFlight.current = false;
      }
    },
    [pendingSelection, handleSend, busy, startup, zoteroEnabled, t]
  );

  // ---- thread actions ----

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      if (threadId === activeThreadId) {
        setDrawerOpen(false);
        return;
      }
      setThreadError(null);
      // Queue belongs to the previous thread's conversation context;
      // carrying it into a different thread would silently mix messages
      // across chats. Drop silently on switch (unlike cancel, which
      // announces via toast — thread swap is an intentional context reset).
      sendQueue.clear();
      try {
        await agentClient.switchThread(threadId);
        chatStreamStore.setActiveThread(threadId);
        await hydrateThread(threadId);
        setDrawerOpen(false);
      } catch (err) {
        setThreadError(`${t('thread.switchFailed')}: ${extractErrorMessage(err)}`);
      }
    },
    [activeThreadId, hydrateThread, t, sendQueue]
  );

  const handleCreateThread = useCallback(async () => {
    setThreadError(null);
    // Same rationale as handleSelectThread — new thread = fresh context.
    sendQueue.clear();
    try {
      const result = await agentClient.newThread();
      chatStreamStore.setActiveThread(result.threadId);
      await refreshThreads();
      setDrawerOpen(false);
    } catch (err) {
      setThreadError(`${t('thread.createFailed')}: ${extractErrorMessage(err)}`);
    }
  }, [refreshThreads, t, sendQueue]);

  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      setThreadError(null);
      // Optimistic: update locally first so the drawer feels responsive.
      setThreads((prev) => prev.map((th) => (th.thread_id === threadId ? { ...th, title } : th)));
      try {
        await agentClient.renameThread(threadId, title);
      } catch (err) {
        setThreadError(`${t('thread.renameFailed')}: ${extractErrorMessage(err)}`);
        // Roll back by re-listing.
        await refreshThreads();
      }
    },
    [refreshThreads, t]
  );

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      setThreadError(null);
      // If the deleted thread is the active one, the queue is about to
      // apply to whatever thread SNACA falls back to — drop it to avoid
      // silently posting into a different conversation.
      if (threadId === activeThreadId) sendQueue.clear();
      try {
        // Main process trusts SNACA's chosen fallback (most-recent surviving
        // thread, or a freshly auto-spawned one when the deleted thread was
        // the last). We just mirror the returned active id into the store.
        const { activeThreadId: nextActive } = await agentClient.deleteThread(threadId);
        chatStreamStore.forgetThread(threadId);
        chatStreamStore.setActiveThread(nextActive);
        if (nextActive !== threadId) {
          void hydrateThread(nextActive);
        }
        await refreshThreads();
      } catch (err) {
        setThreadError(`${t('thread.deleteFailed')}: ${extractErrorMessage(err)}`);
      }
    },
    [hydrateThread, refreshThreads, t, activeThreadId, sendQueue]
  );

  // ---- placeholders / labels ----

  const placeholder = useMemo(() => {
    switch (startup.kind) {
      case 'idle':
        return t('chat.startupIdle');
      case 'starting':
        return t('chat.initializing');
      case 'error':
        return t('chat.startupError', { message: startup.message });
      default:
        return undefined;
    }
  }, [startup, t]);

  const threadTitle = isUntitledThread(activeThread?.title)
    ? t('thread.newConversation')
    : (activeThread?.title ?? t('thread.newConversation'));
  const isEmpty = messages.length === 0 && !currentTurn;

  // Single composer element: centered hero in empty state, docked at the bottom otherwise.
  const composer = (
    <AgentChatInput
      busy={busy}
      disabled={startup.kind !== 'ready'}
      placeholder={placeholder}
      allowQueueWhileBusy
      queuePlaceholder={t('chat.queue.hint')}
      onSend={handleSend}
      onCancel={handleCancel}
      seedValue={seedValue}
      seedKey={seedKey}
      composer={{
        label: t('chat.composerTaskMode'),
        armedTooltip: t('chat.composerChatMode'),
        idleTooltip: t('chat.composerTaskMode'),
      }}
    />
  );

  // The card sits above the composer in both empty and normal states —
  // keeping it out of AgentChatInput itself avoids leaking card state into
  // the textarea's autocomplete/seed machinery. Composer stays interactive
  // while the card is shown so a user who prefers to type a custom prompt
  // can still do so.
  const composerBlock = (
    <>
      {pendingSelection && (
        <SelectionActionCard
          selection={pendingSelection}
          onAction={(action) => void handleSelectionAction(action)}
          onDismiss={() => setPendingSelection(null)}
          disabled={busy || startup.kind !== 'ready'}
          disabledActions={
            // Only gate the button when we KNOW Zotero is off (`false`).
            // While the config is still loading (`null`), let the user
            // click — the LLM's tool call will surface any real problem
            // more accurately than a stale disabled state.
            //
            // Derive the reason map from ZOTERO_GATED_REASON_KEYS so a
            // second gated action added to the table lights up here
            // automatically. Prior hand-written entry duplicated the
            // action id + i18n key across two spots.
            zoteroEnabled === false
              ? Object.fromEntries(
                  (
                    Object.entries(ZOTERO_GATED_REASON_KEYS) as [SelectionAction, TranslationKey][]
                  ).map(([action, key]) => [action, t(key)])
                )
              : undefined
          }
        />
      )}
      <QueuedMessagesChip items={sendQueue.items} onRemove={sendQueue.remove} />
      {composer}
    </>
  );

  return (
    <div
      className="relative flex h-full flex-col bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]"
      style={{ '--chat-font-size': `${chatFontSize}px` } as React.CSSProperties}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="cursor-pointer rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t('thread.historyTitle')}
            aria-expanded={drawerOpen}
            title={t('thread.historyTitle')}
            onClick={() => setDrawerOpen((v) => !v)}
            disabled={startup.kind !== 'ready'}
          >
            <History size={14} aria-hidden="true" />
          </button>
          <span
            className="truncate text-[12px] font-medium text-[var(--color-text-primary)]"
            title={threadTitle}
          >
            {threadTitle}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThreadCopyButton disabled={startup.kind !== 'ready'} />
          <button
            type="button"
            className="cursor-pointer rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t('thread.newThread')}
            title={t('thread.newThread')}
            onClick={handleCreateThread}
            disabled={startup.kind !== 'ready' || busy}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
          <StartupBadge state={startup} />
        </div>
      </header>

      {threadError && (
        <div
          role="alert"
          className="border-b border-[var(--color-border)] bg-[var(--color-error-muted)] px-3 py-1.5 text-[11px] text-[var(--color-error)]"
        >
          {threadError}
        </div>
      )}

      {startup.kind === 'needs-config' ? (
        <div className="flex-1 overflow-y-auto">
          <NeedsConfigCard onOpenSettings={() => uiService.setSidebarTab('settings')} />
        </div>
      ) : isEmpty ? (
        <div className="flex-1 overflow-y-auto">
          <EmptyState
            composerSlot={composerBlock}
            onPickExample={(text) => {
              // Drop the raw text into the input (editable before sending) instead of
              // routing through requestChatWithText, which would wrap it in a
              // `> quote block` — not appropriate for an example prompt.
              setSeedValue(text);
              setSeedKey((k) => k + 1);
            }}
          />
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-4">
            {/* Centered reading column: narrow rail uses w-full, wide screens cap at max-w-3xl with horizontal gutters aligned to the bottom composer. */}
            <div className="mx-auto w-full max-w-3xl px-4">
              {messages.map((m, idx) => (
                <ChatMessage
                  key={`${m.role}-${m.ts}-${m.turnId ?? idx}`}
                  message={m}
                  completedTurn={
                    m.role === 'assistant' && m.turnId
                      ? chatStreamStore.getTurn(m.turnId)
                      : undefined
                  }
                />
              ))}
              {currentTurn && <ChatMessage message={null} turn={currentTurn} />}
            </div>
          </div>
          <div className="pb-3">{composerBlock}</div>
        </>
      )}

      <ThreadHistoryDrawer
        open={drawerOpen}
        threads={threads}
        activeThreadId={activeThreadId}
        onClose={() => setDrawerOpen(false)}
        onSelect={handleSelectThread}
        onCreate={handleCreateThread}
        onRename={handleRenameThread}
        onDelete={handleDeleteThread}
      />
    </div>
  );
}

/**
 * memo: when the main page swaps panels the shell re-renders, but this
 * component's props (workspaceRoot/displayName) are stable, so the whole
 * chat subtree (including N ChatMessage reconciliations) is skipped.
 * Streaming re-renders are driven by the internal chatStreamStore
 * subscription and are unaffected by the memo.
 */
export const ChatSidebar = memo(ChatSidebarInner);

/**
 * Header-mounted "copy the entire chat thread" affordance. Reads the
 * current active thread directly from chatStreamStore (rather than wiring
 * `messages` through props) — the button is purely an on-demand action
 * and doesn't need to re-render with each streamed delta.
 *
 * On click: serialize → write to clipboard → flip to a transient ✓ for
 * 1.5s as visual confirmation. Disabled while the agent is still starting
 * up so we don't put a stale/empty thread on the clipboard.
 */
function ThreadCopyButton({ disabled }: { disabled: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    const messages = chatStreamStore.getMessages();
    if (messages.length === 0) return;
    const text = serializeChatThread({
      messages,
      resolveTurn: (id) => chatStreamStore.getTurn(id),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (e.g. focus lost) — silent; the user can retry.
    }
  }, []);
  return (
    <button
      type="button"
      className="cursor-pointer rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={t('thread.copyThread')}
      title={t('thread.copyThread')}
      onClick={() => void onClick()}
      disabled={disabled}
    >
      {copied ? (
        <Check size={14} className="text-[var(--color-success)]" aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}

function StartupBadge({ state }: { state: StartupState }): React.ReactElement {
  const { t } = useTranslation();
  switch (state.kind) {
    case 'idle':
      return (
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {t('chat.status.disconnected')}
        </span>
      );
    case 'starting':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          {t('chat.status.initializing')}
        </span>
      );
    case 'ready':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-success)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          {t('chat.status.connected')}
        </span>
      );
    case 'needs-config':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-muted)]" />
          {t('chat.status.unconfigured')}
        </span>
      );
    case 'error':
      return (
        <span
          className="flex items-center gap-1.5 text-[10px] text-[var(--color-error)]"
          title={state.message}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)]" />
          {t('chat.status.error')}
        </span>
      );
  }
}

/**
 * 'needs-config' guidance card — replaces the red startup error on first
 * entry. Tone is quiet onboarding rather than failure; the main action
 * is "Open Settings" (routed via UIService, the same path used by the
 * command palette). Once the user fills in the key, ChatSidebar's
 * AI-config listener retries automatically; no manual reconnect needed.
 */
function NeedsConfigCard({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-6 text-center">
      <div className="flex flex-col items-center gap-2 text-[var(--color-text-muted)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] text-[var(--color-accent)]">
          <Settings2 size={18} aria-hidden="true" />
        </div>
        <div className="text-[13px] font-medium text-[var(--color-text-secondary)]">
          {t('chat.needsConfig.title')}
        </div>
        <div className="max-w-[260px] text-[11px] leading-relaxed">
          {t('chat.needsConfig.desc')}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      >
        {t('chat.needsConfig.openSettings')}
      </button>
    </div>
  );
}

function EmptyState({
  onPickExample,
  composerSlot,
}: {
  onPickExample: (text: string) => void;
  composerSlot?: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const examples = [t('chat.examplePrompt1'), t('chat.examplePrompt2'), t('chat.examplePrompt3')];
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-6 text-center">
      <div className="flex flex-col items-center gap-2 text-[var(--color-text-muted)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] text-[var(--color-accent)]">
          <Bot size={18} aria-hidden="true" />
        </div>
        <div className="text-[13px] text-[var(--color-text-secondary)]">
          {t('chat.welcomeTitle')}
        </div>
        <div className="text-[11px]">{t('chat.welcomeSubtitle')}</div>
      </div>

      {composerSlot && <div className="w-full">{composerSlot}</div>}

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[10px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 font-mono">@</kbd>
          {t('chat.hintFiles')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 font-mono">Enter</kbd>
          {t('chat.hintSend')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 font-mono">
            Shift+Enter
          </kbd>
          {t('chat.hintNewline')}
        </span>
      </div>

      <div className="flex w-full max-w-[280px] flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          <span className="inline-flex items-center gap-1">
            <MessageCircleQuestion size={11} aria-hidden="true" />
            {t('chat.tryExamples')}
          </span>
        </div>
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onPickExample(ex)}
            className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Compose the prompt text seeded into the chat input when the user hits an
 * "Ask AI about this compile error" button. Kept terse — SNACA can read
 * `diagnostics` from the auto-built `ChatContext` so we don't dump the raw
 * log here, only enough to anchor the question.
 */
function formatErrorPrompt(req: AskAIAboutErrorRequest): string {
  const where = req.file && req.line != null ? `${req.file}:${req.line}` : (req.file ?? '');
  const intro = translate('chat.compileErrorIntro', {
    compiler: req.compilerType,
    where: where ? ` (${where})` : '',
  });
  // Include the specific error content too, not just a one-line title — the
  // Agent already gets full diagnostics from ChatContext; here we anchor the
  // specific error the user clicked.
  const detail = req.errorContent?.trim()
    ? `${req.errorMessage.trim()}\n\n${req.errorContent.trim()}`
    : req.errorMessage.trim();
  return `${intro}\n\n${detail}\n\n${translate('chat.compileErrorAsk')}`;
}
