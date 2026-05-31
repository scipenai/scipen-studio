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

import { History, Plus } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useEvent } from '../../hooks';
import { useTranslation } from '../../locales';
import { agentClient, type ThreadSummary } from '../../services/agent/AgentClientService';
import { buildChatContext } from '../../services/agent/ChatContextBuilder';
import { buildMentions } from '../../services/AtMentionResolver';
import { chatStreamStore } from '../../services/agent/ChatStreamStore';
import { getUIService } from '../../services/core/ServiceRegistry';
import type { AskAIAboutErrorRequest } from '../../services/core/UIService';
import { AgentChatInput, type SendIntent } from './AgentChatInput';
import { ChatMessage } from './ChatMessage';
import { ThreadHistoryDrawer } from './ThreadHistoryDrawer';

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
  | { kind: 'error'; message: string };

export function ChatSidebar({ workspaceRoot, displayName }: ChatSidebarProps): React.ReactElement {
  const { t } = useTranslation();
  const [startup, setStartup] = useState<StartupState>({ kind: 'idle' });
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
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

  // Start the project session once the workspaceRoot is known.
  useEffect(() => {
    if (!workspaceRoot) return;
    if (startedFor.current === workspaceRoot) return;
    startedFor.current = workspaceRoot;

    setStartup({ kind: 'starting' });
    setThreadError(null);
    void agentClient
      .startProject(workspaceRoot, displayName)
      .then((res) => {
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
        setStartup({ kind: 'error', message: extractErrorMessage(err) });
      });
  }, [workspaceRoot, displayName]);

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

  const hydrateThread = useCallback(async (threadId: string) => {
    try {
      const { messages: wire } = await agentClient.getMessages(threadId);
      chatStreamStore.replaceMessages(threadId, wire);
    } catch (err) {
      setThreadError(`${t('thread.loadFailed')}: ${extractErrorMessage(err)}`);
    }
  }, [t]);

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

  const handleSend = useCallback(
    async (text: string, intent: SendIntent) => {
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
      } catch (err) {
        setStartup({ kind: 'error', message: extractErrorMessage(err) });
      }
    },
    [refreshThreads, workspaceRoot]
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
      setThreads((prev) =>
        prev.map((th) => (th.thread_id === threadId ? { ...th, title } : th))
      );
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
        return '请先打开一个项目';
      case 'starting':
        return '初始化中…';
      case 'error':
        return `启动失败：${startup.message}`;
      case 'ready':
      default:
        return undefined;
    }
  }, [startup]);

  const threadTitle = activeThread?.title || t('thread.newConversation');

  return (
    <div className="relative flex h-full flex-col bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            title={t('thread.historyTitle')}
            onClick={() => setDrawerOpen((v) => !v)}
            disabled={startup.kind !== 'ready'}
          >
            <History size={14} />
          </button>
          <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]" title={threadTitle}>
            {threadTitle}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
            title={t('thread.newThread')}
            onClick={handleCreateThread}
            disabled={startup.kind !== 'ready' || busy}
          >
            <Plus size={14} />
          </button>
          <StartupBadge state={startup} />
        </div>
      </header>

      {threadError && (
        <div className="border-b border-[var(--color-border)] bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
          {threadError}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !currentTurn ? (
          <EmptyState />
        ) : (
          <>
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
          </>
        )}
      </div>

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

function StartupBadge({ state }: { state: StartupState }): React.ReactElement {
  switch (state.kind) {
    case 'idle':
      return <span className="text-[10px] text-[var(--color-text-muted)]">未连接</span>;
    case 'starting':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          初始化中
        </span>
      );
    case 'ready':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          已连接
        </span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-red-400" title={state.message}>
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
          错误
        </span>
      );
  }
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[12px] text-[var(--color-text-muted)]">
      <div className="text-[24px]">✦</div>
      <div>问 AI 任何关于这份文档的问题</div>
      <div className="text-[10px]">支持思考模型（thinking）流式显示</div>
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
  const where =
    req.file && req.line != null
      ? `${req.file}:${req.line}`
      : req.file ?? '';
  const head = where
    ? `${req.compilerType} 编译报错 (${where}):`
    : `${req.compilerType} 编译报错:`;
  return `${head}\n\n${req.errorMessage.trim()}\n\n帮我看看怎么修。`;
}
