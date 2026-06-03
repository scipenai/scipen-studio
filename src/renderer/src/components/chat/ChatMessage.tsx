/**
 * @file ChatMessage - one rendered row in the chat log.
 *
 * Either a finalized user/assistant message (`message` + optional
 * `completedTurn`) or a live in-flight assistant turn (`turn`).
 * Finalized assistant messages still show the thinking trace and tool
 * calls — collapsed by default — so a conversation re-opened later keeps
 * the same context the user saw mid-generation.
 */

import { ChevronRight, CornerDownLeft, FileCog, FilePlus, FileX, FilePen, Loader2 } from 'lucide-react';
import { useCallback, useState, type ReactElement } from 'react';
import { agentClient } from '../../services/agent/AgentClientService';
import {
  chatStreamStore,
  type ChatApprovalRequest,
  type ChatMessage as ChatMessageData,
  type ChatPlan,
  type ChatPlanFile,
  type ChatProposalRecord,
  type ChatTimelineEvent,
  type ChatTurn,
} from '../../services/agent/ChatStreamStore';
import { agentEditProposalBridge } from '../../services/agent/AgentEditProposalBridge';
import { useTranslation, type TranslationKey } from '../../locales';
import { openFileInEditor } from '../../services/core/FileOpenService';
import { getUIService } from '../../services/core/ServiceRegistry';
import { MarkdownContent } from './MarkdownContent';
import { ThinkingRenderer } from './ThinkingRenderer';
import { CopyButton } from '../ui';

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface ChatMessageProps {
  message: ChatMessageData | null;
  /** When set, this is the live in-flight assistant turn. */
  turn?: ChatTurn;
  /** When set on a finalized assistant message, surface the turn's
   *  thinking + tool-call history (collapsed by default). */
  completedTurn?: ChatTurn;
}

/**
 * Plan-aware text gating: composer-plan turns stream the plan body as raw
 * JSON, then the host parses it into a structured PlanCard. The raw JSON
 * is redundant noise once the card materializes — and even while still
 * streaming it's an unreadable partial fenced block. Suppress in either
 * case so the card is the only plan surface.
 */
function shouldSuppressPlanText(turn: ChatTurn | undefined): boolean {
  if (!turn) return false;
  if (turn.plan) return true;
  return turn.origin === 'composer' && turn.pending;
}

export function ChatMessage({ message, turn, completedTurn }: ChatMessageProps): ReactElement {
  const { t } = useTranslation();
  if (turn) {
    const suppressText = shouldSuppressPlanText(turn);
    const showWaiting =
      turn.pending && !suppressText && turn.events.length === 0;
    const showPlanComposing =
      suppressText && turn.pending && !turn.plan;
    return (
      <div className="mb-3">
        <Timeline
          events={turn.events}
          toolCalls={turn.toolCalls}
          pending={turn.pending}
          suppressText={suppressText}
        />
        {turn.plan && <PlanCard plan={turn.plan} turnId={turn.turnId} />}
        <ApprovalList approvals={turn.approvals} />
        <ProposalsList proposals={turn.proposals} />
        {showPlanComposing && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
            {t('chat.statusComposingPlan')}
          </div>
        )}
        {showWaiting && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
            {t('chat.statusWaiting')}
          </div>
        )}
        {turn.error && <ErrorBlock error={turn.error} />}
        {turn.usage && !turn.pending && <UsageLine turn={turn} />}
      </div>
    );
  }

  if (!message) return <></>;

  if (message.role === 'user') {
    return (
      <div className="mb-3 flex gap-2 chat-msg-text leading-[1.6]">
        <span aria-hidden="true" className="select-none font-semibold text-[var(--color-accent)]">
          ›
        </span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-[var(--color-text-primary)]">
          {message.text}
        </div>
      </div>
    );
  }

  const suppressText = shouldSuppressPlanText(completedTurn);
  // Records persisted before text became a timeline event have thinking +
  // tool events but no text event — fall back to rendering `message.text`
  // at the end so legacy threads still show the assistant's reply.
  const hasTextEvent =
    completedTurn?.events?.some((e) => e.kind === 'text') ?? false;
  const renderLegacyTail = !suppressText && !hasTextEvent && message.text.length > 0;
  return (
    <div className="group mb-3">
      {completedTurn && (
        <Timeline
          events={completedTurn.events}
          toolCalls={completedTurn.toolCalls}
          pending={false}
          suppressText={suppressText}
        />
      )}
      {completedTurn?.plan && (
        <PlanCard plan={completedTurn.plan} turnId={completedTurn.turnId} />
      )}
      {completedTurn && <ProposalsList proposals={completedTurn.proposals} />}
      {renderLegacyTail && (
        <div className="chat-msg-text leading-[1.6]">
          <MarkdownContent content={message.text} />
        </div>
      )}
      {message.text && (
        <div className="mt-1 flex justify-start opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <CopyButton text={message.text} />
        </div>
      )}
      {completedTurn?.usage && <UsageLine turn={completedTurn} />}
    </div>
  );
}

function Timeline({
  events,
  toolCalls,
  pending,
  suppressText,
}: {
  events: ChatTimelineEvent[];
  toolCalls: ChatTurn['toolCalls'];
  pending: boolean;
  /** Composer-plan turns hide raw JSON text events in favor of PlanCard. */
  suppressText: boolean;
}): ReactElement | null {
  if (events.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {events.map((ev, i) => {
        const isLast = i === events.length - 1;
        if (ev.kind === 'thinking') {
          return (
            <ThinkingRenderer
              key={`th-${i}`}
              text={ev.text}
              streaming={isLast && pending}
            />
          );
        }
        if (ev.kind === 'text') {
          if (suppressText) return null;
          const streaming = isLast && pending;
          return (
            <div key={`tx-${i}`} className="chat-msg-text leading-[1.6]">
              {streaming ? (
                // 流式期间渲纯文本,避免每个 token 重解析整段 markdown 引发重排抖动;
                // turn 完成后一次性切到 markdown 渲染(对齐 Reasonix Message 模式)。
                <div className="whitespace-pre-wrap break-words">
                  {ev.text}
                  <span className="streaming-cursor" />
                </div>
              ) : (
                <MarkdownContent content={ev.text} />
              )}
            </div>
          );
        }
        const call = toolCalls.find((t) => t.toolCallId === ev.toolCallId);
        if (!call) return null;
        return <ToolCallCard key={ev.toolCallId} call={call} />;
      })}
    </div>
  );
}

function ToolCallCard({ call }: { call: ChatTurn['toolCalls'][number] }): ReactElement {
  const [open, setOpen] = useState(false);
  const argsPreview = formatArgsPreview(call.args);
  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-left text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
      >
        <ChevronRight
          size={10}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className={`font-medium ${statusColor(call.status)}`}>{statusGlyph(call.status)}</span>
        <span className="font-medium text-[var(--color-text-secondary)]">{call.tool}</span>
        {argsPreview && (
          <span className="truncate text-[var(--color-text-muted)]">{argsPreview}</span>
        )}
        {call.message && !open && (
          <span className="ml-auto truncate text-[var(--color-text-muted)]">{call.message}</span>
        )}
      </button>
      {open && (
        <div className="ml-3 space-y-1 border-l border-[var(--color-border-subtle)] py-1 pl-3">
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
        className={`max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-primary)] px-2 py-1 leading-[1.5] text-[var(--color-text-primary)] ${
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
      return 'text-[var(--color-success)]';
    case 'error':
      return 'text-[var(--color-error)]';
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

/**
 * SNACA editor-protocol application error codes — mirror of
 * `snaca_editor_protocol::ErrorCode::as_i32` (see error.rs in snaca).
 * Numeric literals because the protocol/schemas layer typed them as
 * `number` once they cross the wire.
 */
const ERR_NOT_INITIALIZED = -32000;
const ERR_LLM_AUTH = -32009;
const ERR_LLM_CONTEXT_OVERFLOW = -32010;
const ERR_LLM_RATE_LIMITED = -32011;
const ERR_TIMEOUT = -32014;

interface FriendlyError {
  /** One-line, action-oriented summary. */
  title: string;
  /** Raw error message preserved for debuggability. */
  detail: string;
  /** If set, surface as a button below the message. */
  action?: 'open_settings';
}

function buildFriendlyError(
  error: { code: number; message: string; recoverable: boolean },
  t: (key: TranslationKey) => string
): FriendlyError {
  const detail = error.message;
  switch (error.code) {
    case ERR_LLM_AUTH:
      return { title: t('chatError.llmAuth'), detail, action: 'open_settings' };
    case ERR_LLM_RATE_LIMITED:
      return { title: t('chatError.llmRateLimited'), detail };
    case ERR_LLM_CONTEXT_OVERFLOW:
      return { title: t('chatError.llmContextOverflow'), detail };
    case ERR_TIMEOUT:
      return { title: t('chatError.timeout'), detail };
    case ERR_NOT_INITIALIZED:
      return { title: t('chatError.notInitialized'), detail };
    default:
      // Fall through to the raw message so users still see the upstream
      // text rather than a generic "something went wrong".
      return { title: t('chatError.generic'), detail };
  }
}

function ErrorBlock({
  error,
}: {
  error: { code: number; message: string; recoverable: boolean };
}): ReactElement {
  const { t } = useTranslation();
  const friendly = buildFriendlyError(error, t);
  const onOpenSettings = useCallback(() => {
    // Same path the command palette uses to open the settings panel —
    // routes through UIService so layout state stays in one place.
    getUIService().setSidebarTab('settings');
  }, []);

  return (
    <div className="mt-2 rounded border border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[var(--color-error-muted)] p-2 text-[11px] text-[var(--color-error)]">
      <div className="font-medium">{friendly.title}</div>
      <div className="mt-1 break-all opacity-80">{friendly.detail}</div>
      {friendly.action === 'open_settings' && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] hover:bg-[var(--color-error-muted)] text-[var(--color-error)]"
        >
          {t('chatError.openSettings')}
        </button>
      )}
    </div>
  );
}

function UsageLine({ turn }: { turn: ChatTurn }): ReactElement {
  const { t } = useTranslation();
  const u = turn.usage;
  return (
    <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[10px] text-[var(--color-text-muted)]">
      {t('chat.usageInOut', { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0 })}
      {u?.cachedInputTokens ? t('chat.usageCached', { cached: u.cachedInputTokens }) : ''}
      {u?.costUsd != null ? ` · $${u.costUsd.toFixed(4)}` : ''}
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

function PlanCard({ plan, turnId }: { plan: ChatPlan; turnId: string }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(plan.awaiting);
  const [pending, setPending] = useState<null | 'accept' | 'reject'>(null);
  const decide = useCallback(
    async (decision: 'accept' | 'reject') => {
      if (pending) return;
      setPending(decision);
      chatStreamStore.markPlanResolved(turnId);
      try {
        await agentClient.confirmPlan(turnId, decision);
      } finally {
        setPending(null);
      }
    },
    [pending, turnId]
  );
  return (
    <div className="mb-2 rounded-md border border-[color-mix(in_srgb,var(--color-accent)_30%,var(--color-border-subtle))] bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)] text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          size={11}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="font-medium text-[var(--color-text-primary)]">{t('chat.planLabel')}</span>
        <span className="text-[var(--color-text-muted)]">
          {plan.files.length > 0 && `${plan.files.length} ${t('chat.planItemsSuffix')}`}
          {plan.files.length > 0 && plan.awaiting && ' · '}
          {plan.awaiting && t('chat.planAwaitingConfirm')}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border-subtle)] px-2.5 py-2 space-y-1.5">
          {plan.rationale && (
            <div className="chat-markdown text-[12px] leading-[1.55] text-[var(--color-text-secondary)]">
              <MarkdownContent content={plan.rationale} />
            </div>
          )}
          {plan.files.length > 0 && (
            <ul className="space-y-1">
              {plan.files.map((f) => (
                <PlanFileRow key={`${f.action}:${f.agentRelativePath}`} file={f} />
              ))}
            </ul>
          )}
          {plan.awaiting && (
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => decide('accept')}
                className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
              >
                {pending === 'accept' && <Loader2 size={11} className="animate-spin" />}
                {t('chat.planAccept')}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => decide('reject')}
                className="inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
              >
                {pending === 'reject' && <Loader2 size={11} className="animate-spin" />}
                {t('chat.planReject')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanFileRow({ file }: { file: ChatPlanFile }): ReactElement {
  const { t } = useTranslation();
  const Icon = planActionIcon(file.action);
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <Icon size={12} className={`mt-0.5 flex-shrink-0 ${planActionColor(file.action)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[10px] text-[var(--color-text-primary)]">
            {file.agentRelativePath}
          </span>
          {file.renameTo && (
            <>
              <CornerDownLeft size={10} className="flex-shrink-0 -rotate-90 text-[var(--color-text-muted)]" />
              <span className="truncate font-mono text-[10px] text-[var(--color-text-primary)]">
                {file.renameTo}
              </span>
            </>
          )}
          <span className={`ml-auto flex-shrink-0 text-[10px] ${planStatusColor(file.status)}`}>
            {planStatusLabel(file.status, t)}
          </span>
        </div>
        {file.summary && (
          <div className="mt-0.5 leading-[1.45] text-[var(--color-text-muted)]">{file.summary}</div>
        )}
      </div>
    </li>
  );
}

function planActionIcon(action: ChatPlanFile['action']): typeof FileCog {
  switch (action) {
    case 'create':
      return FilePlus;
    case 'delete':
      return FileX;
    case 'rename':
      return FilePen;
    case 'modify':
    default:
      return FileCog;
  }
}

function planActionColor(action: ChatPlanFile['action']): string {
  switch (action) {
    case 'create':
      return 'text-[var(--color-success)]';
    case 'delete':
      return 'text-[var(--color-error)]';
    case 'rename':
      return 'text-[var(--color-warning)]';
    case 'modify':
    default:
      return 'text-[var(--color-accent)]';
  }
}

function planStatusColor(status: ChatPlanFile['status']): string {
  switch (status) {
    case 'done':
      return 'text-[var(--color-success)]';
    case 'in_progress':
      return 'text-[var(--color-accent)]';
    case 'failed':
    case 'rejected':
      return 'text-[var(--color-error)]';
    case 'pending':
    default:
      return 'text-[var(--color-text-muted)]';
  }
}

function planStatusLabel(status: ChatPlanFile['status'], t: T): string {
  switch (status) {
    case 'pending':
      return t('chat.planStatusPending');
    case 'in_progress':
      return t('chat.planStatusInProgress');
    case 'done':
      return t('chat.planStatusDone');
    case 'rejected':
      return t('chat.planStatusRejected');
    case 'failed':
      return t('chat.planStatusFailed');
  }
}

function ProposalsList({ proposals }: { proposals: ChatProposalRecord[] }): ReactElement | null {
  if (proposals.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {proposals.map((p) => (
        <ProposalRow key={p.proposalId} proposal={p} />
      ))}
    </div>
  );
}

function ProposalRow({ proposal }: { proposal: ChatProposalRecord }): ReactElement {
  const { t } = useTranslation();
  const fileName = lastSegment(proposal.agentRelativePath);
  // Click rescues a stuck "waiting for review" card by re-materializing.
  // fs op MUST use absolutePath — agentRelativePath is display only and
  // would resolve against process.cwd() at the IPC boundary (rejected by
  // safePathSchema since the Layer 1 fix, but using the right field keeps
  // the intent obvious).
  const onClick = useCallback(async () => {
    if (proposal.status !== 'pending') return;
    await openFileInEditor(proposal.absolutePath);
    await agentEditProposalBridge.retryMaterialize(proposal.proposalId);
  }, [proposal.absolutePath, proposal.proposalId, proposal.status]);
  const interactive = proposal.status === 'pending';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      className={`flex w-full items-center gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] text-left ${
        interactive ? 'hover:border-[var(--color-accent)] cursor-pointer' : 'cursor-default'
      }`}
      title={
        interactive
          ? t('chat.proposalClickHint', { file: proposal.agentRelativePath })
          : proposal.agentRelativePath
      }
    >
      <FilePen size={11} className="flex-shrink-0 text-[var(--color-accent)]" />
      <span className="truncate font-mono text-[10px] text-[var(--color-text-primary)]">{fileName}</span>
      <span className="flex-shrink-0 text-[var(--color-text-muted)]">
        · {proposal.hunkCount} {t('chat.proposalChangesSuffix')}
      </span>
      <span className={`ml-auto flex-shrink-0 ${proposalStatusColor(proposal.status)}`}>
        {proposalStatusLabel(proposal.status, t)}
      </span>
    </button>
  );
}

function proposalStatusColor(status: ChatProposalRecord['status']): string {
  switch (status) {
    case 'accepted':
      return 'text-[var(--color-success)]';
    case 'rejected':
      return 'text-[var(--color-text-muted)]';
    case 'pending':
    default:
      return 'text-[var(--color-accent)]';
  }
}

function proposalStatusLabel(status: ChatProposalRecord['status'], t: T): string {
  switch (status) {
    case 'pending':
      return t('chat.proposalPending');
    case 'accepted':
      return t('chat.proposalAccepted');
    case 'rejected':
      return t('chat.proposalRejected');
  }
}

function lastSegment(path: string): string {
  if (!path) return '';
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function ApprovalList({
  approvals,
}: {
  approvals: ChatApprovalRequest[];
}): ReactElement | null {
  // Only show pending cards — resolved ones disappear (the tool's
  // outcome surfaces via the regular tool-call card from SNACA's stream).
  const pending = approvals.filter((a) => a.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {pending.map((a) => (
        <ApprovalCard key={a.toolCallId} approval={a} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: ChatApprovalRequest }): ReactElement {
  const { t } = useTranslation();
  const argsPreview = formatArgsPreview(approval.args);

  const decide = useCallback(
    async (decision: 'allow' | 'allow_always' | 'deny') => {
      // Optimistic flip so the card stops looking active before the
      // IPC round trip lands; engine timeout will Deny if we never get there.
      chatStreamStore.markApprovalResolved(approval.toolCallId);
      try {
        await agentClient.confirmTool({ toolCallId: approval.toolCallId, decision });
      } catch {
        /* best-effort */
      }
    },
    [approval.toolCallId]
  );

  return (
    <div
      className={`rounded-md border p-2 ${riskBorder(approval.risk)} text-[11px] bg-[var(--color-bg-secondary)]`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className={`text-[10px] uppercase tracking-wider ${riskText(approval.risk)}`}>
          {approval.risk}
        </span>
        <span className="font-medium text-[var(--color-text-primary)]">{approval.tool}</span>
      </div>
      {approval.summary && (
        <div className="mb-1.5 text-[var(--color-text-muted)]">{approval.summary}</div>
      )}
      {argsPreview && (
        <pre className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-bg-primary)] px-1.5 py-1 font-mono text-[10px] text-[var(--color-text-primary)]">
          {argsPreview}
        </pre>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void decide('allow')}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
        >
          {t('chat.approvalAllowOnce')}
        </button>
        <button
          type="button"
          onClick={() => void decide('allow_always')}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
        >
          {t('chat.approvalAllowAlways')}
        </button>
        <button
          type="button"
          onClick={() => void decide('deny')}
          className="rounded border border-[var(--color-error)]/50 bg-[var(--color-error-muted)] px-2 py-0.5 text-[10px] text-[var(--color-error)] hover:opacity-90"
        >
          {t('chat.approvalDeny')}
        </button>
      </div>
    </div>
  );
}

function riskBorder(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high':
      return 'border-[color-mix(in_srgb,var(--color-error)_50%,transparent)]';
    case 'medium':
      return 'border-[color-mix(in_srgb,var(--color-warning)_50%,transparent)]';
    case 'low':
    default:
      return 'border-[var(--color-border-subtle)]';
  }
}

function riskText(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high':
      return 'text-[var(--color-error)]';
    case 'medium':
      return 'text-[var(--color-warning)]';
    case 'low':
    default:
      return 'text-[var(--color-text-muted)]';
  }
}
