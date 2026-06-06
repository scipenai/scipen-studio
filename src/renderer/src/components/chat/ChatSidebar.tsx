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
  // 「未配置 LLM」是预期初始态,与下面的运行时 error 显式区分:前者渲染引导卡
  // (去设置填 key),后者才是红色报错。判定由主进程负责(见 AGENT_NOT_CONFIGURED_MARKER)。
  | { kind: 'needs-config' }
  | { kind: 'error'; message: string };

/**
 * 已 startProject 过的项目缓存(模块级,跨组件挂载存活)。主页面三面板改为
 * 声明式条件渲染后,折叠聊天会卸载 ChatSidebar、展开会重挂 —— 用它让重挂
 * 只恢复本地 UI(startup/threads),不再重跑 startProject / reset 已有会话。
 * chatStreamStore 本就是模块级单例,消息在卸载期间继续累积、重挂后照常显示。
 */
const startedProjects = new Map<string, { sessionId: string; threads: ThreadSummary[] }>();

/** 从用户首条消息派生兜底标题(LLM 不可用/失败时用):取首行、剥引用/附件标记/markdown、截断。 */
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
  // 让一次性挂载的 AI-config 监听器能读到最新 startup 态(避免把 startup 塞进它的
  // 依赖、反复重订阅)。
  const startupRef = useRef<StartupState>(startup);
  startupRef.current = startup;
  // 自动重试触发器:置位即让 start effect 重跑(配合 startedFor 守卫复位)。
  const [retryNonce, setRetryNonce] = useState(0);
  // 自动重试的待发定时器:逐字符输入 key 会触发一串配置变更,只保留最后一次。
  const retryTimerRef = useRef<number | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // 给 handleSend 提供最新 threads 快照,避免把 threads 列进其 deps 造成频繁重建。
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
  // 重挂载安全:同一 root 已 start 过 → 只恢复本地 UI,不再 startProject、
  // 不 reset 已有 chatStreamStore(面板切换卸载/重挂时对话不丢)。
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
        // includes(非全等):Electron 会给跨进程 Error.message 加
        // "Error invoking remote method '…':" 前缀,标记被夹在中间。
        if (message.includes(AGENT_NOT_CONFIGURED_MARKER)) {
          setStartup({ kind: 'needs-config' });
        } else {
          setStartup({ kind: 'error', message });
        }
      });
  }, [workspaceRoot, displayName, retryNonce]);

  // 填完 API key 自动恢复:AI 配置变更时,若当前正卡在「未配置」,清掉本项目的
  // start 守卫并 bump retryNonce 让上面的 start effect 重跑。延迟 500ms(防抖,仅留
  // 最后一次)让主进程那条 debounce(300ms)的 sidecar 重启先落定,避免重试撞上
  // sidecar 重启中途 —— 主进程拥有 sidecar 生命周期,我们在它稳定后再发起。
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

  // 新会话首条消息后,用补全模型生成会话主题;失败/未配置则回退首句截取。
  // 仅在会话尚无标题时触发,手动改过名的会话不被覆盖。
  const autoGenerateTitle = useCallback(
    async (threadId: string, userText: string) => {
      let title = deriveTitleFromText(userText);
      try {
        const res = await api.ai.generateTitle(userText);
        if (res.success && res.content?.trim()) {
          title = res.content.trim().slice(0, 24);
        }
      } catch {
        // 保留兜底标题
      }
      if (!title) return;
      setThreads((prev) => prev.map((th) => (th.thread_id === threadId ? { ...th, title } : th)));
      try {
        await agentClient.renameThread(threadId, title);
        void refreshThreads();
      } catch {
        // 落库失败不影响本地展示
      }
    },
    [refreshThreads]
  );

  const handleSend = useCallback(
    async (text: string, intent: SendIntent) => {
      // 在写入本轮消息前判定:这是否是某个尚无标题会话的第一条消息。
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

  // 单一 composer 元素:空态置于 hero 中央、有对话时落底部(docked)。
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
              // 直填输入框原文(可改后再发),不走 requestChatWithText —— 那条会把
              // 文本包成 `> 引用块`,不适合示例 prompt。
              setSeedValue(text);
              setSeedKey((k) => k + 1);
            }}
          />
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-4">
            {/* 居中阅读列:窄侧栏时 w-full 占满,宽屏时 max-w-3xl 居中,左右留白(对齐底部输入框) */}
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
 * memo:主页面切面板时 shell 会重渲,但本组件 props(workspaceRoot/displayName)
 * 稳定 → 跳过整棵聊天子树重渲(含 N 条 ChatMessage 的 reconciliation)。
 * 流式时由内部 chatStreamStore 订阅自行重渲,不受 memo 影响。
 */
export const ChatSidebar = memo(ChatSidebarInner);

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
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-success)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          已连接
        </span>
      );
    case 'needs-config':
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-muted)]" />
          待配置
        </span>
      );
    case 'error':
      return (
        <span
          className="flex items-center gap-1.5 text-[10px] text-[var(--color-error)]"
          title={state.message}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)]" />
          错误
        </span>
      );
  }
}

/**
 * 「未配置 LLM」引导卡 —— 取代首次进入时的红色启动报错。语气为安静引导而非错误,
 * 主操作是「打开设置」(走 UIService,与命令面板同一条开设置面板的路径)。填完
 * key 后由 ChatSidebar 的 AI-config 监听器自动重试,用户无需手动重连。
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
  // 把被点击的那条错误的具体内容也带上,不只一行 title —— Agent 另从 ChatContext
  // 拿到完整 diagnostics,这里负责锚定用户实际点的错误。
  const detail = req.errorContent?.trim()
    ? `${req.errorMessage.trim()}\n\n${req.errorContent.trim()}`
    : req.errorMessage.trim();
  return `${intro}\n\n${detail}\n\n${translate('chat.compileErrorAsk')}`;
}
