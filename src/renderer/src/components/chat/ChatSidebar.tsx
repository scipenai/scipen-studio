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

import { Check, Copy, History, Plus } from 'lucide-react';
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
import { t as translate, useTranslation } from '../../locales';
import { agentClient, type ThreadSummary } from '../../services/agent/AgentClientService';
import { buildChatContext } from '../../services/agent/ChatContextBuilder';
import { buildMentions } from '../../services/AtMentionResolver';
import { api } from '../../api';
import { chatStreamStore } from '../../services/agent/ChatStreamStore';
import { getSettingsService, getUIService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { AGENT_NOT_CONFIGURED_MARKER } from '../../../../../shared/ipc/types';
import type { AskAIAboutErrorRequest } from '../../services/core/UIService';
import { AgentChatInput, type SendIntent } from './AgentChatInput';
import { ChatMessage } from './ChatMessage';
import { ThreadHistoryDrawer } from './ThreadHistoryDrawer';
import { serializeChatThread } from '../../utils/serializeChatThread';

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
  const startedFor = useRef<string | null>(null);
  const uiService = useMemo(() => getUIService(), []);

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
  }, [workspaceRoot, displayName, retryNonce]);

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

  // ---- thread RPC helpers ----

  const refreshThreads = useCallback(async () => {
    try {
      const list = await agentClient.listThreads();
      setThreads(list);
    } catch (err) {
      // Non-fatal — keep the stale list.
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

  // ---- inbound prompt injection (Ask-AI buttons → input seed) ----

  useEvent(
    uiService.onDidRequestAIErrorAnalysis,
    (req: AskAIAboutErrorRequest) => {
      setSeedValue(formatErrorPrompt(req));
      setSeedKey((k) => k + 1);
    },
    []
  );

  useEvent(
    uiService.onDidRequestChatWithText,
    ({ text }) => {
      const quoted = text.trim() ? `> ${text.trim().replace(/\n/g, '\n> ')}\n\n` : '';
      setSeedValue(quoted);
      setSeedKey((k) => k + 1);
    },
    []
  );

  // ---- send / cancel ----

  const busy = currentTurn?.pending === true;

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
    async (text: string, intent: SendIntent) => {
      // Decide before writing this turn: is this the first message in a
      // not-yet-titled thread?
      const titleThreadId = chatStreamStore.getActiveThreadId();
      const isFirstMessage = chatStreamStore.getMessages().length === 0;
      const existingThread = threadsRef.current.find((th) => th.thread_id === titleThreadId);
      const needsTitle = Boolean(isFirstMessage && titleThreadId && !existingThread?.title);
      try {
        const context = buildChatContext();
        // Resolve `@path` tokens into structured `Mention[]` so the LLM
        // receives the inline file content via SNACA's typed channel
        // rather than as opaque chat text. cleanedText keeps the user
        // message readable (tokens become `[attached: path]` markers).
        const { mentions, cleanedText } = await buildMentions(text, workspaceRoot);
        if (mentions.length > 0) {
          context.mentions = [...(context.mentions ?? []), ...mentions];
        }
        const payload = cleanedText;
        if (intent === 'composer') {
          const { turnId } = await agentClient.startComposer(payload, context, 'plan_first');
          chatStreamStore.beginComposerTurn(turnId, payload);
        } else {
          const { turnId } = await agentClient.sendChat(payload, context);
          chatStreamStore.beginUserTurn(turnId, payload);
        }
        void refreshThreads();
        if (needsTitle && titleThreadId) void autoGenerateTitle(titleThreadId, text);
      } catch (err) {
        setStartup({ kind: 'error', message: extractErrorMessage(err) });
      }
    },
    [refreshThreads, workspaceRoot, autoGenerateTitle]
  );

  const handleCancel = useCallback(async () => {
    if (!currentTurn) return;
    await agentClient.cancelTurn(currentTurn.turnId);
  }, [currentTurn]);

  // ---- thread actions ----

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      if (threadId === activeThreadId) {
        setDrawerOpen(false);
        return;
      }
      setThreadError(null);
      try {
        await agentClient.switchThread(threadId);
        chatStreamStore.setActiveThread(threadId);
        await hydrateThread(threadId);
        setDrawerOpen(false);
      } catch (err) {
        setThreadError(`${t('thread.switchFailed')}: ${extractErrorMessage(err)}`);
      }
    },
    [activeThreadId, hydrateThread, t]
  );

  const handleCreateThread = useCallback(async () => {
    setThreadError(null);
    try {
      const result = await agentClient.newThread();
      chatStreamStore.setActiveThread(result.threadId);
      await refreshThreads();
      setDrawerOpen(false);
    } catch (err) {
      setThreadError(`${t('thread.createFailed')}: ${extractErrorMessage(err)}`);
    }
  }, [refreshThreads, t]);

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
    [hydrateThread, refreshThreads, t]
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

  const threadTitle = activeThread?.title || t('thread.newConversation');
  const isEmpty = messages.length === 0 && !currentTurn;

  // Single composer element: centered hero in empty state, docked at the bottom otherwise.
  const composer = (
    <AgentChatInput
      busy={busy}
      disabled={startup.kind !== 'ready'}
      placeholder={placeholder}
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

  return (
    <div
      className="relative flex h-full flex-col bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]"
      style={{ '--chat-font-size': `${chatFontSize}px` } as React.CSSProperties}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-40"
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
            className="rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-40"
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
            composerSlot={composer}
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
          <div className="pb-3">{composer}</div>
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
      className="rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-40"
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
        <div className="text-[24px]">✦</div>
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
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
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
        <div className="text-[24px]">✦</div>
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
          <kbd className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 font-mono">⏎</kbd>
          {t('chat.hintSend')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 font-mono">⇧⏎</kbd>
          {t('chat.hintNewline')}
        </span>
      </div>

      <div className="flex w-full max-w-[280px] flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          {t('chat.tryExamples')}
        </div>
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onPickExample(ex)}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
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
