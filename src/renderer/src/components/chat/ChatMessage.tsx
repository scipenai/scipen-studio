/**
 * @file ChatMessage - one rendered row in the chat log.
 *
 * Either a finalized user/assistant message (`message`) or a live
 * in-flight assistant turn (`turn`). Live turns get thinking + streaming
 * cursor; finalized messages don't.
 */

import type React from 'react';
import type { ChatMessage as ChatMessageData, ChatTurn } from '../../services/agent/ChatStreamStore';
import { ThinkingRenderer } from './ThinkingRenderer';

interface ChatMessageProps {
  message: ChatMessageData | null;
  /** When set, this is the live in-flight assistant turn. */
  turn?: ChatTurn;
}

export function ChatMessage({ message, turn }: ChatMessageProps): React.ReactElement {
  if (turn) {
    // Live in-flight assistant turn.
    return (
      <div className="mb-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2.5">
        <RoleBadge role="assistant" pending />
        {turn.hasThinking && <ThinkingRenderer text={turn.thinkingText} streaming={turn.pending} />}
        <ToolCalls turn={turn} />
        {turn.text ? (
          <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]">
            {turn.text}
            {turn.pending && <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-[var(--color-accent)] align-middle" />}
          </div>
        ) : (
          turn.pending && !turn.hasThinking && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
              等待回复…
            </div>
          )
        )}
        {turn.error && (
          <div className="mt-2 rounded border border-red-400/40 bg-red-400/10 p-2 text-[11px] text-red-300">
            {turn.error.message}
          </div>
        )}
        {turn.usage && !turn.pending && <UsageLine turn={turn} />}
      </div>
    );
  }

  if (!message) return <></>;

  if (message.role === 'user') {
    return (
      <div className="mb-3 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] p-2.5">
        <RoleBadge role="user" />
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2.5">
      <RoleBadge role="assistant" />
      <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]">{message.text}</div>
    </div>
  );
}

function RoleBadge({ role, pending }: { role: 'user' | 'assistant'; pending?: boolean }): React.ReactElement {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
      <span>{role === 'user' ? 'You' : 'Assistant'}</span>
      {pending && <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--color-accent)]" />}
    </div>
  );
}

function ToolCalls({ turn }: { turn: ChatTurn }): React.ReactElement | null {
  if (turn.toolCalls.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {turn.toolCalls.map((tc) => (
        <div key={tc.toolCallId} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px]">
          <span className={`font-medium ${statusColor(tc.status)}`}>● {tc.tool}</span>
          {tc.message && <span className="ml-2 text-[var(--color-text-muted)]">{tc.message}</span>}
        </div>
      ))}
    </div>
  );
}

function statusColor(status: 'pending' | 'progress' | 'success' | 'error'): string {
  switch (status) {
    case 'pending':
    case 'progress':
      return 'text-[var(--color-accent)]';
    case 'success':
      return 'text-emerald-400';
    case 'error':
      return 'text-red-400';
  }
}

function UsageLine({ turn }: { turn: ChatTurn }): React.ReactElement {
  return (
    <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[10px] text-[var(--color-text-muted)]">
      tokens in {turn.usage?.inputTokens ?? 0} · out {turn.usage?.outputTokens ?? 0}
      {turn.usage?.cachedInputTokens ? ` · cached ${turn.usage.cachedInputTokens}` : ''}
      {turn.usage?.costUsd != null ? ` · $${turn.usage.costUsd.toFixed(4)}` : ''}
    </div>
  );
}
