/**
 * @file serializeChatThread - markdown serializer for an entire chat thread.
 *
 * Used by `ThreadCopyButton` to put the whole conversation on the clipboard
 * as a single paste-able block (versus the per-message CopyButton which only
 * grabs one assistant reply at a time).
 *
 * Output shape — one block per message, blank-line separated:
 *
 *   > user text...
 *
 *   **Assistant**
 *   <thinking summary, if any>
 *   <tool calls list>
 *   <edit proposals list>
 *   <assistant final text>
 *
 * Thinking/tool/propose are summaries (not full payloads) so the paste stays
 * readable. Raw tool args/results are intentionally omitted — they're easily
 * thousands of tokens and almost never what a "copy thread" user wants.
 */
import type { ChatMessage, ChatTurn } from '../services/agent/ChatStreamStore';

export interface SerializeChatThreadInput {
  messages: ChatMessage[];
  /** Resolver from `turnId` to the persisted turn record (for assistant blocks). */
  resolveTurn: (turnId: string) => ChatTurn | undefined;
}

export function serializeChatThread({ messages, resolveTurn }: SerializeChatThreadInput): string {
  return messages.map((m) => serializeMessage(m, resolveTurn)).join('\n\n');
}

function serializeMessage(
  m: ChatMessage,
  resolveTurn: SerializeChatThreadInput['resolveTurn']
): string {
  if (m.role === 'user') {
    // Quoted user lines (`>` per line) survive the round-trip through any
    // markdown viewer and visually mirror how the chat panel renders them.
    return m.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }
  const parts: string[] = ['**Assistant**'];
  const turn = m.turnId ? resolveTurn(m.turnId) : undefined;
  if (turn) {
    const thinkingSummary = summarizeThinking(turn.thinkingText);
    if (thinkingSummary) parts.push(thinkingSummary);
    const toolSummary = summarizeToolCalls(turn.toolCalls);
    if (toolSummary) parts.push(toolSummary);
    const proposalSummary = summarizeProposals(turn.proposals);
    if (proposalSummary) parts.push(proposalSummary);
  }
  if (m.text) parts.push(m.text);
  return parts.join('\n\n');
}

function summarizeThinking(thinkingText: string): string | null {
  const trimmed = thinkingText.trim();
  if (!trimmed) return null;
  // Truncate aggressively — full thinking traces are routinely 1000+ tokens
  // and the user has explicit access to them in the UI if they want them.
  const max = 400;
  const body = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return `_<thinking>_ ${body.replace(/\n+/g, ' ')}`;
}

function summarizeToolCalls(toolCalls: ChatTurn['toolCalls']): string | null {
  if (toolCalls.length === 0) return null;
  const lines = toolCalls.map((tc) => `- ${statusGlyph(tc.status)} \`${tc.tool}\``);
  return lines.join('\n');
}

function summarizeProposals(proposals: ChatTurn['proposals']): string | null {
  if (proposals.length === 0) return null;
  const lines = proposals.map(
    (p) => `- [edit] \`${p.agentRelativePath}\` (${p.hunkCount} hunks, ${p.status})`
  );
  return lines.join('\n');
}

function statusGlyph(status: 'pending' | 'progress' | 'success' | 'error'): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'progress':
      return '◐';
    case 'success':
      return '✓';
    case 'error':
      return '✗';
  }
}
