/**
 * @file WordCountSegment.tsx — StatusBar segment showing document length.
 *
 * Researchers write against hard limits (journal word caps, thesis chapter
 * budgets), so the number needs to be visible while drafting rather than
 * behind a menu. Counting rules live in `utils/wordCount.ts`; this component
 * only decides *when* to recount and how to render it.
 *
 * Own file so StatusBar stays near the repo's 500-line guidance — same
 * rationale as AgentStatusSegment.
 */

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RunOnceScheduler } from '../../../../../shared/utils';
import { useEvent } from '../../hooks';
import { useTranslation } from '../../locales';
import { getEditorService } from '../../services/core/ServiceRegistry';
import { useActiveTabPath } from '../../services/core/hooks';
import { countWords, wordCountModeForFile, type WordCountResult } from '../../utils/wordCount';

/** Recount delay after the last keystroke. Long enough that fast typing does
 *  not run the stripper on every character, short enough to feel live. */
const RECOUNT_DELAY_MS = 400;

function formatCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export const WordCountSegment: React.FC = () => {
  const { t } = useTranslation();
  const activeTabPath = useActiveTabPath();
  const [result, setResult] = useState<WordCountResult | null>(null);

  const mode = useMemo(() => wordCountModeForFile(activeTabPath), [activeTabPath]);

  // Recount is debounced through a scheduler rather than a raw timeout so the
  // pending run is cancelled on unmount / tab switch instead of firing against
  // a stale document. The latest text lives in a ref — it is scheduler input,
  // not render state, so storing it in state would re-render on every keystroke
  // (exactly what the debounce exists to avoid).
  const pendingTextRef = useRef<string | null>(null);
  const recountScheduler = useMemo(
    () =>
      new RunOnceScheduler(() => {
        const text = pendingTextRef.current;
        if (text !== null) setResult(countWords(text, mode));
        pendingTextRef.current = null;
      }, RECOUNT_DELAY_MS),
    [mode]
  );

  useEffect(() => () => recountScheduler.dispose(), [recountScheduler]);

  // Seed from the active tab, and reseed on tab switch — the content relay
  // only fires on edits, so without this the segment would stay blank until
  // the user types.
  useEffect(() => {
    const content = getEditorService().activeTab?.content ?? null;
    setResult(content === null ? null : countWords(content, mode));
  }, [activeTabPath, mode]);

  // `onActiveEditorContentChanged` (a Relay filtered to the active tab) is the
  // only reactive source here: `useEditorTabs` deliberately excludes content
  // events to avoid re-rendering the tree on every keystroke.
  useEvent(
    getEditorService().onActiveEditorContentChanged,
    (e) => {
      pendingTextRef.current = e.content;
      recountScheduler.schedule();
    },
    [recountScheduler]
  );

  if (!result) return null;

  return (
    <div
      className="flex h-full flex-shrink-0 items-center gap-2 px-3 text-[11px]"
      style={{
        borderRight: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-muted)',
      }}
      title={t('statusBar.wordCountHint', {
        words: String(result.words),
        chars: String(result.characters),
      })}
    >
      <span>{t('statusBar.words', { count: formatCount(result.words) })}</span>
    </div>
  );
};
