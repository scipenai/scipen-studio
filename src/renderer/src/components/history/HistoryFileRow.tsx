/**
 * @file HistoryFileRow - shared file-with-diff-stats list row for Browse
 *   dialogs (labels and steps). Same shape lives on both sides since a
 *   label snapshot and a step snapshot expose identical file metadata.
 *
 * Right-end action is a single Eye button that opens FileDiffOverlay. The
 * button stays hidden until the row is hovered or keyboard-focused (kept
 * reachable with focus:opacity-100 so a tab-only user can still trigger it).
 */

import { Eye } from 'lucide-react';
import type { ReactElement } from 'react';
import type { TranslationKey } from '../../locales';

/**
 * Shared shape for a file inside a history label or step snapshot.
 *
 * `beforeText` is the snapshot bytes decoded to string; `afterText` is the
 * current open-tab content (null when the file isn't open). `stats` is null
 * when the file isn't open — distinct from "open but identical" (0/0 stats).
 */
export interface HistoryFileSnapshot {
  fileId: string;
  beforeText: string;
  afterText: string | null;
  stats: { added: number; removed: number } | null;
}

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function HistoryFileRow({
  file,
  onViewDiff,
  t,
}: {
  file: HistoryFileSnapshot;
  onViewDiff: (f: HistoryFileSnapshot) => void;
  t: T;
}): ReactElement {
  const viewable = file.stats !== null && (file.stats.added > 0 || file.stats.removed > 0);
  return (
    <li className="group flex items-center gap-1.5 truncate rounded px-1 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
      <span className="min-w-0 flex-1 truncate">{file.fileId}</span>
      {file.stats === null ? (
        <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
          {t('history.diffStatsClosed')}
        </span>
      ) : file.stats.added === 0 && file.stats.removed === 0 ? (
        <span className="flex-shrink-0 text-[9px] text-[var(--color-text-muted)]">
          {t('history.diffStatsNoChange')}
        </span>
      ) : (
        <span className="flex-shrink-0 tabular-nums">
          {/*
           * Diff perspective:we render "what Restore would change",so the
           * value the user is about to *regain* lives in `stats.removed`
           * (text present in snapshot but missing from current tab) and the
           * value about to be *discarded* lives in `stats.added`. Hence the
           * green "+removed" / red "-added" swap.
           */}
          <span className="text-[var(--color-success)]">+{file.stats.removed}</span>
          <span className="px-0.5 text-[var(--color-text-muted)]">/</span>
          <span className="text-[var(--color-error)]">-{file.stats.added}</span>
        </span>
      )}
      {viewable && (
        <button
          type="button"
          onClick={() => onViewDiff(file)}
          title={t('history.viewDiff')}
          aria-label={t('history.viewDiff')}
          className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100"
        >
          <Eye size={11} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
