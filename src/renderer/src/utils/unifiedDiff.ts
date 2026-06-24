/**
 * @file unifiedDiff - render a `before / after` text pair as line-level
 *   diff segments suitable for inline UI display. Same line-mapping recipe
 *   as `DiffReviewService.computeLineHunks` (diff-match-patch + linesToChars)
 *   but emits per-line tokens instead of grouped hunks so we can render a
 *   plain GitHub-style unified diff.
 */

import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  /** Stable per-line key for React rendering. */
  id: string;
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the *old* content; null for added lines. */
  oldLineNo: number | null;
  /** 1-based line number in the *new* content; null for removed lines. */
  newLineNo: number | null;
}

/** Maximum lines to render per file — keeps the overlay snappy on huge diffs. */
const MAX_DIFF_LINES = 5_000;

export function computeUnifiedDiff(oldContent: string, newContent: string): DiffLine[] {
  if (oldContent === newContent) return [];

  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldContent, newContent);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  dmp.diff_cleanupSemantic(diffs);

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let seq = 0;
  for (const [op, text] of diffs) {
    if (lines.length >= MAX_DIFF_LINES) break;
    const segLines = splitLines(text);
    for (const line of segLines) {
      if (lines.length >= MAX_DIFF_LINES) break;
      // Monotonic seq keeps keys unique even for repeated blank/context
      // lines while staying stable across re-renders of the same diff.
      const id = `${seq++}`;
      if (op === 0) {
        lines.push({ id, kind: 'context', text: line, oldLineNo: oldNo, newLineNo: newNo });
        oldNo++;
        newNo++;
      } else if (op === 1) {
        lines.push({ id, kind: 'added', text: line, oldLineNo: null, newLineNo: newNo });
        newNo++;
      } else {
        lines.push({ id, kind: 'removed', text: line, oldLineNo: oldNo, newLineNo: null });
        oldNo++;
      }
    }
  }
  return lines;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  // diff-match-patch slices use trailing \n on multi-line chunks; drop the
  // empty tail to avoid a spurious blank line at the end of each segment.
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}
