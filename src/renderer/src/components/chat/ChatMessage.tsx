/**
 * @file ChatMessage - one rendered row in the chat log.
 *
 * Either a finalized user/assistant message (`message` + optional
 * `completedTurn`) or a live in-flight assistant turn (`turn`).
 * Finalized assistant messages still show the thinking trace and tool
 * calls — collapsed by default — so a conversation re-opened later keeps
 * the same context the user saw mid-generation.
 */

import {
  AlertTriangle,
  ChevronRight,
  CornerDownLeft,
  FileCog,
  FilePlus,
  FileX,
  FilePen,
  HelpCircle,
  Loader2,
  RotateCcw,
  ShieldAlert,
  SkipForward,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
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
  type ChatUserQuestion,
  type ChatUserQuestionSpec,
} from '../../services/agent/ChatStreamStore';
import { agentEditProposalBridge } from '../../services/agent/AgentEditProposalBridge';
import { useTranslation, type TranslationKey } from '../../locales';
import { api } from '../../api';
import { openFileInEditor } from '../../services/core/FileOpenService';
import {
  getProjectRuntimeContext,
  getUIService,
} from '../../services/core/ServiceRegistry';
import { applySnapshotToOpenTabs } from '../../utils/historyRestore';
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
    const showWaiting = turn.pending && !suppressText && turn.events.length === 0;
    const showPlanComposing = suppressText && turn.pending && !turn.plan;
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
        <QuestionsList questions={turn.questions} />
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
      <div className="group/user mb-3 flex gap-2 chat-msg-text leading-[1.6]">
        <span aria-hidden="true" className="select-none font-semibold text-[var(--color-accent)]">
          ›
        </span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-[var(--color-text-primary)]">
          {message.text}
        </div>
        <RollbackBeforeMessageButton messageTs={message.ts} />
      </div>
    );
  }

  const suppressText = shouldSuppressPlanText(completedTurn);
  // Records persisted before text became a timeline event have thinking +
  // tool events but no text event — fall back to rendering `message.text`
  // at the end so legacy threads still show the assistant's reply.
  const hasTextEvent = completedTurn?.events?.some((e) => e.kind === 'text') ?? false;
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
      {completedTurn?.plan && <PlanCard plan={completedTurn.plan} turnId={completedTurn.turnId} />}
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

/**
 * Inline icon button shown on hover over every user message. Clicking it
 * resolves the most recent SNACA-tool step recorded *before* this message in
 * the active chat thread, confirms with the user, and applies that step's
 * tree to the currently open tabs (write + setContentFromExternal). If no
 * step is on file the button surfaces a friendly toast via native dialog.
 */
function RollbackBeforeMessageButton({ messageTs }: { messageTs: number }): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const onClick = useCallback(async () => {
    if (busy) return;
    const projectId = getProjectRuntimeContext().projectId;
    const threadId = chatStreamStore.getActiveThreadId();
    if (!projectId || !threadId) {
      await api.dialog.confirm(t('history.rollbackNoSession'), t('history.rollbackBeforeTitle'));
      return;
    }
    setBusy(true);
    try {
      const sessionId = `chat-${threadId}`;
      const step = await api.history.findStepBeforeTs({
        projectId,
        sessionId,
        beforeTs: messageTs,
      });
      if (!step) {
        await api.dialog.confirm(t('history.rollbackNoStep'), t('history.rollbackBeforeTitle'));
        return;
      }
      const ok = await api.dialog.confirm(
        t('history.rollbackBeforeConfirm'),
        t('history.rollbackBeforeTitle')
      );
      if (!ok) return;
      const snapshot = await api.history.resolveStepSnapshot({
        projectId,
        hashHex: step.hashHex,
      });
      await applySnapshotToOpenTabs(snapshot);
    } catch {
      // Best-effort; the user can read the dialog and retry.
    } finally {
      setBusy(false);
    }
  }, [busy, messageTs, t]);

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={busy}
      title={t('history.rollbackBefore')}
      aria-label={t('history.rollbackBefore')}
      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] group-hover/user:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
    </button>
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
          return <ThinkingRenderer key={`th-${i}`} text={ev.text} streaming={isLast && pending} />;
        }
        if (ev.kind === 'text') {
          if (suppressText) return null;
          const streaming = isLast && pending;
          return (
            <div key={`tx-${i}`} className="chat-msg-text leading-[1.6]">
              {streaming ? (
                // Render plain text while streaming to avoid re-parsing the
                // whole markdown block on every token (causes reflow jitter);
                // switch to markdown rendering once the turn finishes
                // (matches the Reasonix Message pattern).
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
  const { t } = useTranslation();
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
        <span className={`font-medium ${statusColor(call.status)}`}>
          {statusGlyph(call.status)}
        </span>
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
            <DetailBlock label={t('chat.toolDetail.args')} body={prettyJson(call.args)} mono />
          )}
          {call.message && <DetailBlock label={t('chat.toolDetail.status')} body={call.message} />}
          {call.result && (
            <DetailBlock label={t('chat.toolDetail.result')} body={call.result} mono />
          )}
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
              <CornerDownLeft
                size={10}
                className="flex-shrink-0 -rotate-90 text-[var(--color-text-muted)]"
              />
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
      <span className="truncate font-mono text-[10px] text-[var(--color-text-primary)]">
        {fileName}
      </span>
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

/**
 * High-risk cards lock the primary Allow action for a short cooldown so
 * the user can't auto-pilot through a destructive call. 1500ms is the
 * sweet spot in security UX literature — long enough to break a reflex
 * click, short enough to not annoy intentional approvers.
 */
const HIGH_RISK_ARMING_MS = 1500;

/**
 * Wire-level enum is `allow | deny | allow_always | deny_always`. UI
 * intentionally does NOT expose `deny_always` until the SNACA engine
 * grows a remembered-deny mode — currently it collapses to `Deny`
 * (snaca-editor/src/approval_gate.rs:`decision_from_wire`), so showing
 * the button would lie about persistence. See that file's TODO.
 */
type ApprovalDecision = 'allow' | 'allow_always' | 'deny' | 'deny_always';

/** Shared button shape for the Deny / Allow-always actions. The Allow-once
 *  button stays inline because it carries the arming overlay. */
function ApprovalActionButton({
  decision,
  idleLabel,
  className,
  lastDecision,
  submitState,
  onClick,
  t,
}: {
  decision: ApprovalDecision;
  idleLabel: string;
  className: string;
  lastDecision: ApprovalDecision | null;
  submitState: 'idle' | 'submitting' | 'error';
  onClick: () => void;
  t: T;
}): ReactElement {
  const isMine = lastDecision === decision;
  const label =
    submitState === 'submitting' && isMine
      ? t('chat.approvalSubmitting')
      : submitState === 'error' && isMine
        ? t('chat.approvalRetry')
        : idleLabel;
  return (
    <button
      type="button"
      data-decision={decision}
      onClick={onClick}
      disabled={submitState === 'submitting'}
      className={className}
    >
      {submitState === 'submitting' && isMine && <Loader2 size={11} className="animate-spin" />}
      {label}
    </button>
  );
}

function ApprovalCard({ approval }: { approval: ChatApprovalRequest }): ReactElement {
  const { t } = useTranslation();
  const argsPreview = formatArgsPreview(approval.args);
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [lastDecision, setLastDecision] = useState<ApprovalDecision | null>(null);
  // `armingMsLeft > 0` means the Allow buttons are still cooling down.
  // Only ever non-zero for high-risk cards.
  const [armingMsLeft, setArmingMsLeft] = useState(
    approval.risk === 'high' ? HIGH_RISK_ARMING_MS : 0
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const armingStartRef = useRef<number>(Date.now());

  // High-risk cooldown ticker. Stops itself once it reaches 0 to avoid
  // pointless re-renders for the rest of the card's lifetime.
  useEffect(() => {
    if (approval.risk !== 'high') return;
    const tick = (): void => {
      const elapsed = Date.now() - armingStartRef.current;
      const left = Math.max(0, HIGH_RISK_ARMING_MS - elapsed);
      setArmingMsLeft(left);
    };
    const id = window.setInterval(tick, 50);
    return () => window.clearInterval(id);
  }, [approval.risk]);

  // Auto-focus: Deny on high-risk (we want the safest action under the
  // user's thumb), Allow once on the rest (matches the most common
  // intentional answer).
  useEffect(() => {
    const sel =
      approval.risk === 'high' ? 'button[data-decision="deny"]' : 'button[data-decision="allow"]';
    cardRef.current?.querySelector<HTMLButtonElement>(sel)?.focus();
  }, [approval.risk]);

  const decide = useCallback(
    async (decision: ApprovalDecision) => {
      if (submitState === 'submitting') return;
      // The cooldown applies to anything that grants the tool — both
      // one-shot and "always". Deny paths are never locked.
      if (
        approval.risk === 'high' &&
        armingMsLeft > 0 &&
        (decision === 'allow' || decision === 'allow_always')
      ) {
        return;
      }
      setSubmitState('submitting');
      setLastDecision(decision);
      try {
        await agentClient.confirmTool({ toolCallId: approval.toolCallId, decision });
        // Hide ONLY after the host acknowledges. The previous version
        // hid optimistically and relied on "engine timeout will Deny" —
        // a load-bearing implicit assumption that this code now no
        // longer makes.
        chatStreamStore.markApprovalResolved(approval.toolCallId);
      } catch {
        setSubmitState('error');
      }
    },
    [approval.risk, approval.toolCallId, armingMsLeft, submitState]
  );

  // Scoped keyboard shortcuts. A=allow, D=deny; Shift escalates to the
  // "always" variant when available for the current risk tier.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (submitState === 'submitting') return;
      // Don't hijack typing inside the args <pre> (it's focusable for
      // scrolling) or any future inline input.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key === 'a') {
        e.preventDefault();
        // High-risk cards drop allow_always entirely — Shift+A still
        // means "Allow once" so the muscle memory isn't punished.
        if (approval.risk === 'high') {
          void decide('allow');
        } else {
          void decide(e.shiftKey ? 'allow_always' : 'allow');
        }
        return;
      }
      if (key === 'd') {
        e.preventDefault();
        // Deny_always intentionally NOT bound: engine collapses it to
        // Deny so the keystroke would lie about persistence.
        void decide('deny');
      }
    },
    [approval.risk, decide, submitState]
  );

  // Risk-tier visual derivations. Kept in one place so the eye-grab
  // intensity scales monotonically with risk.
  const topBarColor = riskTopBarColor(approval.risk);
  const Icon = approval.risk === 'high' ? ShieldAlert : AlertTriangle;
  const showRiskIcon = approval.risk !== 'low';

  const armingPct = approval.risk === 'high' ? (armingMsLeft / HIGH_RISK_ARMING_MS) * 100 : 0;
  const isArming = armingMsLeft > 0;

  const allowLabel =
    submitState === 'submitting' && lastDecision === 'allow'
      ? t('chat.approvalSubmitting')
      : submitState === 'error' && lastDecision === 'allow'
        ? t('chat.approvalRetry')
        : isArming
          ? t('chat.approvalArming', { seconds: Math.ceil(armingMsLeft / 1000) })
          : t('chat.approvalAllowOnce');

  return (
    <div
      ref={cardRef}
      onKeyDown={handleKeyDown}
      role="group"
      aria-label={approval.tool}
      tabIndex={-1}
      className={`overflow-hidden rounded-md border ${riskBorder(approval.risk)} bg-[var(--color-bg-secondary)] text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]`}
    >
      <div className="h-0.5" style={{ backgroundColor: topBarColor }} aria-hidden />

      <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-1.5">
        {showRiskIcon && <Icon size={12} className={riskText(approval.risk)} />}
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${riskText(approval.risk)}`}
        >
          {approval.risk}
        </span>
        <span className="font-mono text-[11px] font-medium text-[var(--color-text-primary)]">
          {approval.tool}
        </span>
        {approval.risk === 'high' && (
          <span className="ml-auto truncate text-[10px] text-[var(--color-error)]">
            {t('chat.approvalHighRiskWarning')}
          </span>
        )}
      </div>

      <div className="px-2.5 py-2">
        {approval.summary && (
          <div className="mb-1.5 text-[var(--color-text-muted)]">{approval.summary}</div>
        )}
        {argsPreview && (
          <pre className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-bg-primary)] px-1.5 py-1 font-mono text-[10px] text-[var(--color-text-primary)]">
            {argsPreview}
          </pre>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border-subtle)] pt-2">
          <span
            className="hidden truncate text-[10px] text-[var(--color-text-muted)] sm:inline"
            aria-hidden
          >
            {t('chat.approvalShortcutHint')}
          </span>
          {submitState === 'error' && (
            <span className="text-[10px] text-[var(--color-error)]">
              {t('chat.approvalSubmitFailed')}
            </span>
          )}

          <div className="ml-auto flex flex-wrap gap-1.5">
            <ApprovalActionButton
              decision="deny"
              idleLabel={t('chat.approvalDeny')}
              className="flex items-center gap-1 rounded border border-[var(--color-error)]/50 bg-[var(--color-error-muted)] px-2 py-0.5 text-[10px] text-[var(--color-error)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              lastDecision={lastDecision}
              submitState={submitState}
              onClick={() => void decide('deny')}
              t={t}
            />

            {/* allow_always — hidden on high risk: a long-lived blanket
                allow on a destructive tool is the exact failure mode the
                cooldown is trying to prevent. */}
            {approval.risk !== 'high' && (
              <ApprovalActionButton
                decision="allow_always"
                idleLabel={t('chat.approvalAllowAlways')}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                lastDecision={lastDecision}
                submitState={submitState}
                onClick={() => void decide('allow_always')}
                t={t}
              />
            )}

            {/* Allow once — primary on low/medium, locked on high until
                the cooldown bar drains. */}
            <button
              type="button"
              data-decision="allow"
              onClick={() => void decide('allow')}
              disabled={submitState === 'submitting' || isArming}
              className={`relative flex items-center gap-1 overflow-hidden rounded border px-2.5 py-0.5 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                approval.risk === 'high'
                  ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning-muted)] text-[var(--color-warning)] hover:opacity-90'
                  : 'border-[var(--color-accent)]/50 bg-[var(--color-accent)] text-white hover:opacity-90'
              }`}
            >
              {/* Cooldown fill — a subtle leftover bar inside the button
                  so the wait is felt, not just told. */}
              {isArming && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--color-warning)]/30"
                  style={{ width: `${armingPct}%` }}
                  aria-hidden
                />
              )}
              {submitState === 'submitting' && lastDecision === 'allow' && (
                <Loader2 size={11} className="animate-spin" />
              )}
              <span className="relative tabular-nums">{allowLabel}</span>
            </button>
          </div>
        </div>
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
    default:
      return 'text-[var(--color-text-muted)]';
  }
}

/**
 * Top-bar accent strip for the approval card. Same monotone severity
 * ramp as `riskBorder` / `riskText`, just at a stronger saturation so
 * the eye reads risk from across the chat scroll, not after squinting.
 */
function riskTopBarColor(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high':
      return 'var(--color-error)';
    case 'medium':
      return 'var(--color-warning)';
    default:
      return 'transparent';
  }
}

function QuestionsList({
  questions,
}: {
  questions: ChatUserQuestion[];
}): ReactElement | null {
  // Mirror ApprovalList: only pending cards render; answered ones vanish
  // (the picked answer flows back to SNACA as the tool_result).
  const pending = questions.filter((q) => q.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {pending.map((q) => (
        <UserQuestionCard key={q.requestId} card={q} />
      ))}
    </div>
  );
}

// `border-transparent` reserves the 1px on every row so the :checked state can
// swap to a visible accent border without shifting layout by a pixel.
const questionOptionRow =
  'flex cursor-pointer items-start gap-1.5 rounded border border-transparent px-1.5 py-1 transition-colors hover:bg-[var(--color-bg-hover)] [&:has(:checked)]:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] [&:has(:checked)]:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]';

function QuestionBlock({
  q,
  groupKey,
  ids,
  other,
  onIds,
  onOther,
  otherLabel,
}: {
  q: ChatUserQuestionSpec;
  /** Card-unique prefix so radio groups don't collide across cards. */
  groupKey: string;
  ids: string[];
  other: string;
  onIds: (ids: string[]) => void;
  onOther: (other: string) => void;
  otherLabel: string;
}): ReactElement {
  const toggle = (optId: string): void => {
    if (q.multiSelect) {
      onIds(ids.includes(optId) ? ids.filter((x) => x !== optId) : [...ids, optId]);
    } else {
      onIds([optId]);
    }
  };
  return (
    <div className="mb-2 last:mb-0">
      {q.header && (
        <span className="mb-1 inline-block rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          {q.header}
        </span>
      )}
      <div className="mb-1 font-medium text-[var(--color-text-primary)]">{q.question}</div>
      <div className="space-y-0.5">
        {q.options.map((o) => (
          <label key={o.id} className={questionOptionRow}>
            <input
              type={q.multiSelect ? 'checkbox' : 'radio'}
              name={`q-${groupKey}-${q.id}`}
              checked={ids.includes(o.id)}
              onChange={() => toggle(o.id)}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="text-[var(--color-text-primary)]">{o.label}</span>
              {o.description && (
                <span className="block text-[10px] text-[var(--color-text-muted)]">
                  {o.description}
                </span>
              )}
              {o.preview && (
                <pre className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-bg-primary)] px-1.5 py-1 font-mono text-[10px] text-[var(--color-text-primary)]">
                  {o.preview}
                </pre>
              )}
            </span>
          </label>
        ))}
      </div>
      {q.allowOther && (
        <input
          type="text"
          value={other}
          onChange={(e) => onOther(e.target.value)}
          placeholder={otherLabel}
          className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-primary)]"
        />
      )}
    </div>
  );
}

/**
 * Mirror of `ContextRequestService.QUESTION_TIMEOUT_MS` (600s). The host
 * is the source of truth — this constant only powers the renderer-side
 * countdown bar. Drift from the host clock is bounded by the initial IPC
 * RTT (sub-second) and is invisible at the user-facing 1s granularity.
 */
const QUESTION_TIMEOUT_MS = 600_000;

function UserQuestionCard({ card }: { card: ChatUserQuestion }): ReactElement {
  const { t } = useTranslation();
  const [picks, setPicks] = useState<Record<string, { ids: string[]; other: string }>>(() =>
    Object.fromEntries(card.questions.map((q) => [q.id, { ids: [], other: '' }]))
  );
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [secondsLeft, setSecondsLeft] = useState(Math.floor(QUESTION_TIMEOUT_MS / 1000));

  const cardRef = useRef<HTMLDivElement>(null);
  // Anchor at the first render of THIS card; replacing it (e.g. via Strict-
  // Mode re-mount) restarts the countdown, which is the correct behaviour.
  const startedAtRef = useRef<number>(Date.now());

  // Countdown ticker. The 1s cadence matches the displayed precision.
  useEffect(() => {
    const tick = (): void => {
      const elapsed = Date.now() - startedAtRef.current;
      const remaining = Math.max(0, QUESTION_TIMEOUT_MS - elapsed);
      setSecondsLeft(Math.ceil(remaining / 1000));
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Drop focus on the first selectable input so keyboard users can act
  // without reaching for the mouse.
  useEffect(() => {
    const first = cardRef.current?.querySelector<HTMLInputElement>(
      'input[type="radio"], input[type="checkbox"]'
    );
    first?.focus();
  }, []);

  const setIds = useCallback((qid: string, ids: string[]) => {
    setPicks((prev) => ({ ...prev, [qid]: { ids, other: prev[qid]?.other ?? '' } }));
  }, []);
  const setOther = useCallback((qid: string, other: string) => {
    setPicks((prev) => ({ ...prev, [qid]: { ids: prev[qid]?.ids ?? [], other } }));
  }, []);

  // Every question needs at least one option or some "other" text.
  const canSubmit = card.questions.every((q) => {
    const p = picks[q.id];
    return (p?.ids.length ?? 0) > 0 || (p?.other.trim().length ?? 0) > 0;
  });

  const submit = useCallback(async () => {
    if (!canSubmit || submitState === 'submitting') return;
    setSubmitState('submitting');
    const answers = card.questions.map((q) => {
      const p = picks[q.id];
      const otherText = (p?.other ?? '').trim();
      return {
        question_id: q.id,
        selected_option_ids: p?.ids ?? [],
        other_text: otherText.length > 0 ? otherText : undefined,
      };
    });
    try {
      await agentClient.respondUserQuestion({
        requestId: card.requestId,
        ok: true,
        answers: { answers },
      });
      // Hide ONLY after the host acknowledges. Hiding before the await
      // would silently abandon dropped replies and the user would wait
      // the full 600s for SNACA to time out on its own.
      chatStreamStore.markQuestionAnswered(card.requestId);
    } catch {
      setSubmitState('error');
    }
  }, [canSubmit, card.questions, card.requestId, picks, submitState]);

  const skip = useCallback(async () => {
    if (submitState === 'submitting') return;
    setSubmitState('submitting');
    try {
      // `ok: false` is the protocol's existing "no usable answer" channel
      // (ContextRequestService.handleQuestion surfaces it as an error to
      // SNACA, which can then decide without the user's input).
      await agentClient.respondUserQuestion({
        requestId: card.requestId,
        ok: false,
        error: 'user_skipped',
      });
      chatStreamStore.markQuestionAnswered(card.requestId);
    } catch {
      setSubmitState('error');
    }
  }, [card.requestId, submitState]);

  // Keyboard shortcuts scoped to the card subtree — global keys would
  // collide with the chat composer.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (submitState === 'submitting') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        void skip();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canSubmit) void submit();
      }
    },
    [canSubmit, skip, submit, submitState]
  );

  const progressPct = Math.max(
    0,
    Math.min(100, ((secondsLeft * 1000) / QUESTION_TIMEOUT_MS) * 100)
  );

  // Three-stop colour so urgency reads at a glance before the bar empties.
  const progressColor =
    progressPct > 50
      ? 'var(--color-success)'
      : progressPct > 20
        ? 'var(--color-warning)'
        : 'var(--color-error)';

  const submitLabel =
    submitState === 'error'
      ? t('chat.questionRetry')
      : submitState === 'submitting'
        ? t('chat.questionSubmitting')
        : t('chat.questionSubmit');

  return (
    <div
      ref={cardRef}
      onKeyDown={handleKeyDown}
      role="group"
      aria-label={t('chat.questionHeader')}
      className="overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-bg-secondary)] text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
    >
      {/* Timeout progress strip — 2px-thin so it reads as a status hint */}
      {/* rather than a primary control. */}
      <div
        className="h-0.5 transition-all duration-1000 ease-linear"
        style={{ width: `${progressPct}%`, backgroundColor: progressColor }}
        aria-hidden
      />

      <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-1.5">
        <HelpCircle size={12} className="text-[var(--color-accent)]" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
          {t('chat.questionHeader')}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-[var(--color-text-muted)]">
          {t('chat.questionTimeRemaining', { seconds: secondsLeft })}
        </span>
      </div>

      <div className="px-2.5 py-2">
        {card.questions.map((q) => {
          const p = picks[q.id];
          const selectedCount = p?.ids.length ?? 0;
          return (
            <div key={q.id} className="mb-2 last:mb-0">
              <QuestionBlock
                q={q}
                groupKey={card.requestId}
                ids={p?.ids ?? []}
                other={p?.other ?? ''}
                onIds={(ids) => setIds(q.id, ids)}
                onOther={(o) => setOther(q.id, o)}
                otherLabel={t('chat.questionOther')}
              />
              {q.multiSelect && selectedCount > 0 && (
                <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  {t('chat.questionSelectedCount', {
                    count: selectedCount,
                    total: q.options.length,
                  })}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-2 flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-2">
          <span className="hidden truncate text-[10px] text-[var(--color-text-muted)] sm:inline">
            {t('chat.questionShortcutHint')}
          </span>
          {submitState === 'error' && (
            <span className="text-[10px] text-[var(--color-error)]">
              {t('chat.questionSubmitFailed')}
            </span>
          )}
          <div className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={() => void skip()}
              disabled={submitState === 'submitting'}
              className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SkipForward size={11} />
              {t('chat.questionSkip')}
            </button>
            <button
              type="button"
              disabled={!canSubmit || submitState === 'submitting'}
              onClick={() => void submit()}
              className="flex items-center gap-1 rounded border border-[var(--color-accent)]/50 bg-[var(--color-accent)] px-2.5 py-0.5 text-[10px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitState === 'submitting' && <Loader2 size={11} className="animate-spin" />}
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
