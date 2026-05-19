/**
 * @file ChatMessage - one rendered row in the chat log.
 *
 * Either a finalized user/assistant message (`message` + optional
 * `completedTurn`) or a live in-flight assistant turn (`turn`).
 * Finalized assistant messages still show the thinking trace and tool
 * calls — collapsed by default — so a conversation re-opened later keeps
 * the same context the user saw mid-generation.
 */

import { ChevronRight } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import type { ChatMessage as ChatMessageData, ChatTurn } from '../../services/agent/ChatStreamStore';
import { MarkdownContent } from './MarkdownContent';
import { ThinkingRenderer } from './ThinkingRenderer';

interface ChatMessageProps {
  message: ChatMessageData | null;
  /** When set, this is the live in-flight assistant turn. */
  turn?: ChatTurn;
  /** When set on a finalized assistant message, surface the turn's
   *  thinking + tool-call history (collapsed by default). */
  completedTurn?: ChatTurn;
}

export function ChatMessage({ message, turn, completedTurn }: ChatMessageProps): ReactElement {
  if (turn) {
    return (
      <div className="mb-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2.5">
        <RoleBadge role="assistant" pending />
        {turn.hasThinking && <ThinkingRenderer text={turn.thinkingText} streaming={turn.pending} />}
        <ToolCalls calls={turn.toolCalls} />
        {turn.text ? (
          <div className="text-[13px] leading-[1.6]">
            <MarkdownContent content={turn.text} />
            {turn.pending && (
              <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-[var(--color-accent)] align-middle" />
            )}
          </div>
        ) : (
          turn.pending &&
          !turn.hasThinking && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
              等待回复…
            </div>
          )
        )}
        {turn.error && <ErrorBlock message={turn.error.message} />}
        {turn.usage && !turn.pending && <UsageLine turn={turn} />}
      </div>
    );
  }

  if (!message) return <></>;

  if (message.role === 'user') {
    return (
      <div className="mb-3 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] p-2.5">
        <RoleBadge role="user" />
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2.5">
      <RoleBadge role="assistant" />
      {completedTurn?.hasThinking && (
        <ThinkingRenderer text={completedTurn.thinkingText} streaming={false} />
      )}
      {completedTurn && <ToolCalls calls={completedTurn.toolCalls} />}
      <div className="text-[13px] leading-[1.6]">
        <MarkdownContent content={message.text} />
      </div>
      {completedTurn?.usage && <UsageLine turn={completedTurn} />}
    </div>
  );
}

function RoleBadge({
  role,
  pending,
}: {
  role: 'user' | 'assistant';
  pending?: boolean;
}): ReactElement {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
      <span>{role === 'user' ? 'You' : 'Assistant'}</span>
      {pending && <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--color-accent)]" />}
    </div>
  );
}

function ToolCalls({ calls }: { calls: ChatTurn['toolCalls'] }): ReactElement | null {
  if (calls.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {calls.map((tc) => (
        <ToolCallCard key={tc.toolCallId} call={tc} />
      ))}
    </div>
  );
}

function ToolCallCard({ call }: { call: ChatTurn['toolCalls'][number] }): ReactElement {
  const [open, setOpen] = useState(false);
  const argsPreview = formatArgsPreview(call.args);
  return (
    <div className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <ChevronRight
          size={10}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className={`font-medium ${statusColor(call.status)}`}>{statusGlyph(call.status)}</span>
        <span className="font-medium text-[var(--color-text)]">{call.tool}</span>
        {argsPreview && (
          <span className="truncate text-[var(--color-text-muted)]">{argsPreview}</span>
        )}
        {call.message && !open && (
          <span className="ml-auto truncate text-[var(--color-text-muted)]">{call.message}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--color-border-subtle)] px-2 py-1.5 space-y-1">
          {call.args !== undefined && (
            <DetailBlock label="参数" body={prettyJson(call.args)} mono />
          )}
          {call.message && <DetailBlock label="状态" body={call.message} />}
          {call.result && <DetailBlock label="结果" body={call.result} mono />}
        </div>
      )}
    </div>
  );
}

function DetailBlock({
  label,
  body,
  mono,
}: {
  label: string;
  body: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <pre
        className={`max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-primary)] px-2 py-1 leading-[1.5] text-[var(--color-text)] ${
          mono ? 'font-mono text-[10px]' : 'text-[11px]'
        }`}
      >
        {body}
      </pre>
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

function statusGlyph(status: 'pending' | 'progress' | 'success' | 'error'): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'progress':
      return '◐';
    case 'success':
      return '●';
    case 'error':
      return '×';
  }
}

function ErrorBlock({ message }: { message: string }): ReactElement {
  return (
    <div className="mt-2 rounded border border-red-400/40 bg-red-400/10 p-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}

function UsageLine({ turn }: { turn: ChatTurn }): ReactElement {
  return (
    <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[10px] text-[var(--color-text-muted)]">
      tokens in {turn.usage?.inputTokens ?? 0} · out {turn.usage?.outputTokens ?? 0}
      {turn.usage?.cachedInputTokens ? ` · cached ${turn.usage.cachedInputTokens}` : ''}
      {turn.usage?.costUsd != null ? ` · $${turn.usage.costUsd.toFixed(4)}` : ''}
    </div>
  );
}

/** Single-line, ~80-char preview of an args record for the collapsed card. */
function formatArgsPreview(args: unknown): string {
  if (args == null || args === '') return '';
  try {
    const json = typeof args === 'string' ? args : JSON.stringify(args);
    const flat = json.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
  } catch {
    return String(args);
  }
}

function prettyJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
