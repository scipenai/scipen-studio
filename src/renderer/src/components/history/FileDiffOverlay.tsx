/**
 * @file FileDiffOverlay - GitHub-style unified diff renderer for a single
 *   `(fileId, before, after)` triple. Mounted on top of BrowseLabelsDialog
 *   when the user clicks a file row's `View diff` action.
 *
 * Pure React + diff-match-patch — no Monaco diff editor: keeps the bundle
 * trim and the dialog feels lighter than spinning up a full editor instance
 * just to render ~hundred lines. For multi-thousand-line diffs the overlay
 * truncates at 5000 lines (see `computeUnifiedDiff`).
 */

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useTranslation } from '../../locales';
import { computeUnifiedDiff, type DiffLine } from '../../utils/unifiedDiff';

export interface FileDiffOverlayProps {
  /** Display name for the diffed file. */
  fileId: string;
  /** Snapshot bytes from the label (decoded via TextDecoder). */
  beforeText: string;
  /** Current editor tab content. `null` means file isn't open → no diff. */
  afterText: string | null;
  /** Triggered on Esc or backdrop click. */
  onClose: () => void;
}

export function FileDiffOverlay({
  fileId,
  beforeText,
  afterText,
  onClose,
}: FileDiffOverlayProps): ReactElement {
  const { t } = useTranslation();
  const lines = useMemo<DiffLine[]>(() => {
    if (afterText === null) return [];
    return computeUnifiedDiff(beforeText, afterText);
  }, [beforeText, afterText]);

  // Esc closes the overlay (sits above the BrowseLabelsDialog Esc handler).
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    // Lock body scroll while overlay is open — small UX touch so users can't
    // accidentally scroll the workspace beneath while inspecting a diff.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.kind === 'added') added++;
      else if (l.kind === 'removed') removed++;
    }
    return { added, removed };
  }, [lines]);

  return (
    <AnimatePresence>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={t('history.diffOverlayTitle', { fileId })}
        onClick={onClose}
        onKeyDown={handleKeyDown}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          className="flex h-[80vh] w-[min(960px,95vw)] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label={t('history.close')}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <ArrowLeft size={14} />
            </button>
            <span className="truncate font-mono text-[11px] font-medium text-[var(--color-text-primary)]">
              {fileId}
            </span>
            {afterText !== null && (
              <span className="flex items-center gap-1 text-[10px] tabular-nums">
                <span className="text-[var(--color-success)]">+{stats.added}</span>
                <span className="text-[var(--color-text-muted)]">/</span>
                <span className="text-[var(--color-error)]">-{stats.removed}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('history.close')}
              className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-auto font-mono text-[11px] leading-snug">
            {afterText === null ? (
              <div className="px-4 py-8 text-center text-[11px] text-[var(--color-text-muted)]">
                {t('history.diffStatsClosed')}
              </div>
            ) : lines.length === 0 ? (
              <div className="px-4 py-8 text-center text-[11px] text-[var(--color-text-muted)]">
                {t('history.diffStatsNoChange')}
              </div>
            ) : (
              <DiffLinesView lines={lines} />
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * One row per diff line: `[old#, new#, sign, text]`. Identical styling to
 * GitHub's unified diff view but using our theme tokens.
 */
function DiffLinesView({ lines }: { lines: DiffLine[] }): ReactElement {
  return (
    <table className="w-full border-separate border-spacing-0">
      <tbody>
        {lines.map((l) => (
          <tr
            key={l.id}
            className={
              l.kind === 'added'
                ? 'bg-[color-mix(in_srgb,var(--color-success)_8%,transparent)]'
                : l.kind === 'removed'
                  ? 'bg-[color-mix(in_srgb,var(--color-error)_8%,transparent)]'
                  : undefined
            }
          >
            <td className="w-10 select-none whitespace-nowrap px-2 text-right text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {l.oldLineNo ?? ''}
            </td>
            <td className="w-10 select-none whitespace-nowrap px-2 text-right text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {l.newLineNo ?? ''}
            </td>
            <td
              className={
                'w-4 select-none px-1 text-center text-[10px] ' +
                (l.kind === 'added'
                  ? 'text-[var(--color-success)]'
                  : l.kind === 'removed'
                    ? 'text-[var(--color-error)]'
                    : 'text-[var(--color-text-muted)]')
              }
            >
              {l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}
            </td>
            <td className="whitespace-pre-wrap break-all px-2 text-[var(--color-text-primary)]">
              {l.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
