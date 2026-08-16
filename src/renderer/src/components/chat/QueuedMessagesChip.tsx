/**
 * @file QueuedMessagesChip — collapsed count chip + expandable list of
 *       messages the user submitted while a turn was in flight. Mounted
 *       above the composer inside ChatSidebar; empty queue → nothing.
 *
 * Deliberately dumb: takes items + onRemove, renders. All queue state
 * lives in the parent (ChatSidebar via useSendQueue).
 */

import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { QueuedMessage } from '../../hooks/useSendQueue';
import { useTranslation } from '../../locales';

interface QueuedMessagesChipProps<TIntent extends string> {
  items: QueuedMessage<TIntent>[];
  onRemove: (id: string) => void;
}

const PREVIEW_MAX_CHARS = 60;

function preview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

export function QueuedMessagesChip<TIntent extends string>({
  items,
  onRemove,
}: QueuedMessagesChipProps<TIntent>): React.ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // ChatSidebar mounts this component unconditionally and it renders null when
  // empty; that means React keeps the component instance alive across
  // drain/clear/cancel/thread-switch cycles. Without this reset the next queued
  // message would reappear pre-expanded — inconsistent with the initial
  // collapsed presentation the user expects.
  useEffect(() => {
    if (items.length === 0) setExpanded(false);
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-4">
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          <span className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            )}
            <span className="font-medium">
              {t('chat.queue.count', { n: String(items.length) })}
            </span>
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {expanded ? t('chat.queue.collapse') : t('chat.queue.expand')}
          </span>
        </button>
        {expanded && (
          <ul className="border-t border-[var(--color-border-subtle)]">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5 last:border-b-0"
              >
                <span className="flex-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                  {preview(item.text)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  aria-label={t('chat.queue.remove')}
                  title={t('chat.queue.remove')}
                  className="mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
