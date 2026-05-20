/**
 * @file AgentStatusSegment.tsx — StatusBar segment for SNACA agent state.
 *
 * Surfaces the active-turn activity (idle / thinking / running a tool),
 * cumulative thread tokens + cost, and a Stop button while a turn is
 * in flight. Lives as its own file so StatusBar stays under the 500-
 * line cap.
 *
 * Data is pulled from `chatStreamStore` via `useSyncExternalStore` so
 * the segment re-renders on every store mutation (same model the
 * ChatSidebar uses).
 */

import { Loader2, Square } from 'lucide-react';
import type React from 'react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from '../../locales';
import { agentClient } from '../../services/agent/AgentClientService';
import { chatStreamStore } from '../../services/agent/ChatStreamStore';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatCost(usd: number): string {
  // Sub-cent costs are common during normal chat; keep enough precision
  // to show "$0.0023" rather than "$0.00".
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export const AgentStatusSegment: React.FC = () => {
  const { t } = useTranslation();
  useSyncExternalStore(
    (cb) => chatStreamStore.subscribe(cb),
    () => chatStreamStore.getVersion(),
    () => chatStreamStore.getVersion()
  );

  const currentTurn = chatStreamStore.getCurrentTurn();
  const activity = chatStreamStore.getAgentActivity();
  const usage = chatStreamStore.getThreadUsageTotal();
  const busy = activity !== null;

  const onStop = (): void => {
    if (!currentTurn?.turnId) return;
    void agentClient.cancelTurn(currentTurn.turnId);
  };

  // Build a single-line status label. Tool name takes priority because
  // "running Bash" is more informative than "thinking".
  let statusLabel: string;
  if (!activity) {
    statusLabel = t('agentStatus.idle');
  } else if (activity.toolName) {
    statusLabel = `${t('agentStatus.tool')} · ${activity.toolName}`;
  } else if (activity.label === 'queued') {
    statusLabel = t('agentStatus.queued');
  } else {
    statusLabel = t('agentStatus.thinking');
  }

  const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;

  return (
    <div
      className="flex items-center gap-3 px-3 h-full flex-shrink-0 text-[11px] font-medium"
      style={{
        borderLeft: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-muted)',
      }}
    >
      {/* Activity dot + label */}
      <span className="flex items-center gap-1.5">
        {busy ? (
          <Loader2 size={10} className="animate-spin text-[var(--color-accent)]" />
        ) : (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--color-text-muted)', opacity: 0.5 }}
          />
        )}
        <span>{statusLabel}</span>
      </span>

      {/* Token / cost — hidden until at least one turn has reported usage */}
      {hasUsage && (
        <span className="flex items-center gap-2" title={t('agentStatus.usageHint')}>
          <span>
            ↑ {formatTokens(usage.inputTokens)}
            {usage.cachedInputTokens > 0 && (
              <span style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                {' '}
                ({formatTokens(usage.cachedInputTokens)} {t('agentStatus.cached')})
              </span>
            )}
          </span>
          <span>↓ {formatTokens(usage.outputTokens)}</span>
          {typeof usage.costUsd === 'number' && <span>{formatCost(usage.costUsd)}</span>}
        </span>
      )}

      {/* Stop — visible only while a turn is in flight */}
      {busy && (
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--color-bg-hover)] text-red-400"
          title={t('agentStatus.stop')}
        >
          <Square size={9} />
          <span>{t('agentStatus.stop')}</span>
        </button>
      )}
    </div>
  );
};
