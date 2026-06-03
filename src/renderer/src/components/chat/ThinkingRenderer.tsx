/**
 * @file ThinkingRenderer - collapsible thinking block.
 *
 * Shown only when the current turn has thinking content (DeepSeek
 * `reasoning_content` / Anthropic extended thinking). Non-thinking models
 * never produce these deltas, so the component is invisible.
 */

import type React from 'react';
import { useState } from 'react';

interface ThinkingRendererProps {
  text: string;
  /** When true, the model is still emitting thinking deltas. */
  streaming?: boolean;
}

export function ThinkingRenderer({
  text,
  streaming,
}: ThinkingRendererProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState<boolean>(streaming ?? false);

  if (!text) return null;

  return (
    <div className="mb-2 border-l-2 border-[var(--color-accent-dim)] pl-2.5 text-[12px]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between gap-2 py-0.5 text-left text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        <span className="flex items-center gap-1.5">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className={expanded ? 'rotate-90 transition' : 'transition'}
          >
            <path d="M3 1 L7 5 L3 9 Z" fill="currentColor" />
          </svg>
          <span className="font-medium">
            {streaming ? '思考中…' : '思考过程'} ({text.length})
          </span>
        </span>
        {streaming && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
        )}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-[var(--color-text-muted)] opacity-90">
          {text}
        </pre>
      )}
    </div>
  );
}
