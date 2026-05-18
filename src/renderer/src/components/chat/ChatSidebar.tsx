/**
 * @file ChatSidebar - the right-rail chat panel (Ctrl+L surface).
 *
 * P1 minimal:
 *  - On first mount, calls `agent.startProject(workspaceRoot)` to ensure a
 *    SNACA session exists.
 *  - Renders the persistent message log.
 *  - Renders the in-flight turn with thinking + streaming text.
 *  - Input box with send/cancel.
 *
 * Project + Settings UI come later; here we accept `workspaceRoot` as a prop
 * and trust the parent to provide it (typically the currently-opened project
 * folder).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { agentClient } from '../../services/agent/AgentClientService';
import { chatStreamStore } from '../../services/agent/ChatStreamStore';
import { AgentChatInput } from './AgentChatInput';
import { ChatMessage } from './ChatMessage';

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
  const [startup, setStartup] = useState<StartupState>({ kind: 'idle' });
  const startedFor = useRef<string | null>(null);

  // Subscribe to chatStreamStore.
  const _store = useSyncExternalStore(
    (cb) => chatStreamStore.subscribe(cb),
    () => chatStreamStore.getMessages().length,
    () => 0
  );
  void _store;

  const messages = chatStreamStore.getMessages();
  const currentTurn = chatStreamStore.getCurrentTurn();

  // Auto-scroll to bottom on new message / delta.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, currentTurn?.text.length, currentTurn?.thinkingText.length]);

  // Start the project session once the workspaceRoot is known.
  useEffect(() => {
    if (!workspaceRoot) return;
    if (startedFor.current === workspaceRoot) return;
    startedFor.current = workspaceRoot;

    setStartup({ kind: 'starting' });
    void agentClient
      .startProject(workspaceRoot, displayName)
      .then((res) => setStartup({ kind: 'ready', sessionId: res.sessionId }))
      .catch((err) => {
        setStartup({ kind: 'error', message: extractErrorMessage(err) });
      });
  }, [workspaceRoot, displayName]);

  const busy = currentTurn?.pending === true;

  const handleSend = useCallback(async (text: string) => {
    try {
      const { turnId } = await agentClient.sendChat(text, {});
      chatStreamStore.beginUserTurn(turnId, text);
    } catch (err) {
      setStartup({ kind: 'error', message: extractErrorMessage(err) });
    }
  }, []);

  const handleCancel = useCallback(async () => {
    if (!currentTurn) return;
    await agentClient.cancelTurn(currentTurn.turnId);
  }, [currentTurn]);

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

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-secondary)] text-[var(--color-text)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Agent
        </span>
        <StartupBadge state={startup} />
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !currentTurn ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((m) => (
              <ChatMessage key={`${m.role}-${m.ts}-${m.turnId ?? ''}`} message={m} />
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
