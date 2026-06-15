/**
 * @file lineDiffStats - cheap line-level add/remove counts using diff-match-patch.
 *
 * Reused by BrowseLabelsDialog to surface "what would Restore actually change?"
 * before the user pulls the trigger. Identical inputs short-circuit to `0/0`
 * so projects with a fresh label (no edits since) read as "no-op" instantly.
 */

import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

export interface LineDiffStats {
  added: number;
  removed: number;
}

export function lineDiffStats(a: string, b: string): LineDiffStats {
  if (a === b) return { added: 0, removed: 0 };
  // diff_linesToChars_ remaps each unique line to a UTF-16 char so diff_main
  // operates in O(lines) rather than O(chars). Same recipe DiffReviewService
  // uses; keeps semantics identical to the AI-side hunk grouping.
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffs) {
    const lines = countLines(text);
    if (op === 1) added += lines;
    else if (op === -1) removed += lines;
  }
  return { added, removed };
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}
