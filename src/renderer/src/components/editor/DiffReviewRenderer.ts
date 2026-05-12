/**
 * @file DiffReviewRenderer.ts — Monaco inline diff renderer (decorations + sweep animation)
 * @description
 *   Line-level highlights (green additions / red gutter) plus deleted content ViewZones (light red background).
 *   Accept/Reject buttons are rendered outside Monaco by a React component (DiffReviewInlineWidget).
 *   Sweep animation: when a bot edit arrives, a highlight line scans from the first change to the last.
 *   As each hunk is revealed, its diff decoration fades from translucent to normal, conveying "AI is writing".
 */

import type * as monaco from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import type { PendingReview, DiffHunk } from '../../services/core/DiffReviewService';

// ====== State ======

export interface DiffDecorationState {
  decorationCollection: monaco.editor.IEditorDecorationsCollection | null;
  viewZoneIds: string[];
  reviewId: string;
  /** Sweep animation cleanup — cancels the animation and reverts to static decorations */
  cancelSweep?: () => void;
}

// ====== Helpers ======

export function countTextLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

export function computeTotalChangedLines(hunks: DiffHunk[]): number {
  let total = 0;
  for (const h of hunks) {
    total += Math.max(countTextLines(h.newText), countTextLines(h.originalText));
  }
  return total;
}

// ====== Line Decorations ======

function hunksToDecorations(
  hunks: DiffHunk[],
  monacoInstance: Monaco
): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  for (const hunk of hunks) {
    if (hunk.type === 'removed') {
      decorations.push({
        range: new monacoInstance.Range(hunk.startLine, 1, hunk.startLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: 'diff-review-removed-gutter',
          overviewRuler: {
            color: 'rgba(222, 143, 133, 0.52)',
            position: monacoInstance.editor.OverviewRulerLane.Right,
          },
        },
      });
      continue;
    }

    decorations.push({
      range: new monacoInstance.Range(hunk.startLine, 1, hunk.endLine, Number.MAX_SAFE_INTEGER),
      options: {
        isWholeLine: true,
        className: 'diff-review-added',
        glyphMarginClassName: 'diff-review-added-gutter',
        overviewRuler: {
          color:
            hunk.type === 'modified' ? 'rgba(198, 162, 87, 0.52)' : 'rgba(108, 174, 159, 0.48)',
          position: monacoInstance.editor.OverviewRulerLane.Right,
        },
      },
    });
  }

  return decorations;
}

// ====== Deleted Content ViewZones ======

function createDeletedViewZones(
  editor: monaco.editor.IStandaloneCodeEditor,
  hunks: DiffHunk[]
): string[] {
  return createDeletedViewZonesWithRefs(editor, hunks, false).zoneIds;
}

// ====== Public API ======

export function renderDiffReview(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoInstance: Monaco,
  review: PendingReview
): DiffDecorationState {
  if (review.hunks.length === 0) {
    return { decorationCollection: null, viewZoneIds: [], reviewId: review.id };
  }

  // 1. Line-level decorations (green-added background + gutter)
  const decorations = hunksToDecorations(review.hunks, monacoInstance);
  const collection = editor.createDecorationsCollection(decorations);

  // 2. ViewZones for deleted content (light red background, no strikethrough)
  const viewZoneIds = createDeletedViewZones(editor, review.hunks);

  return { decorationCollection: collection, viewZoneIds, reviewId: review.id };
}

/**
 * Create ViewZones and return both zone IDs and DOM references
 * (the DOM nodes let the sweep animation toggle the pending class).
 */
function createDeletedViewZonesWithRefs(
  editor: monaco.editor.IStandaloneCodeEditor,
  hunks: DiffHunk[],
  pending: boolean
): { zoneIds: string[]; domNodes: HTMLElement[] } {
  const zoneIds: string[] = [];
  const domNodes: HTMLElement[] = [];

  editor.changeViewZones((accessor) => {
    for (const hunk of hunks) {
      if (!hunk.originalText) continue;

      const lines = hunk.originalText.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (lines.length === 0) continue;

      const domNode = document.createElement('div');
      domNode.className = `diff-review-removed-zone${pending ? ' diff-review-sweep-pending' : ''}`;

      for (const line of lines) {
        const lineEl = document.createElement('div');
        lineEl.textContent = line || ' ';
        domNode.appendChild(lineEl);
      }

      const zoneId = accessor.addZone({
        afterLineNumber: Math.max(1, hunk.startLine - 1),
        heightInLines: lines.length,
        domNode,
        suppressMouseDown: true,
      });
      zoneIds.push(zoneId);
      domNodes.push(domNode);
    }
  });

  return { zoneIds, domNodes };
}

/**
 * Sweep-animated renderer: start with translucent decorations plus a sweep line, then light up
 * decorations row by row as the sweep passes. Switches to the static state when the animation ends.
 * Used when a bot edit first arrives.
 */
export function renderDiffReviewWithSweep(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoInstance: Monaco,
  review: PendingReview
): DiffDecorationState {
  if (review.hunks.length === 0) {
    return { decorationCollection: null, viewZoneIds: [], reviewId: review.id };
  }

  const firstLine = Math.min(...review.hunks.map((h) => h.startLine));
  const lastLine = Math.max(...review.hunks.map((h) => h.endLine));
  const totalLines = lastLine - firstLine + 1;

  // 1. Translucent decorations (pending state)
  const pendingDecorations = hunksToDecorations(review.hunks, monacoInstance).map((d) => ({
    ...d,
    options: {
      ...d.options,
      className: d.options.className
        ? `${d.options.className} diff-review-sweep-pending`
        : 'diff-review-sweep-pending',
    },
  }));
  const collection = editor.createDecorationsCollection(pendingDecorations);

  // 2. ViewZones for deleted content — start translucent; keep DOM refs so we can drop the pending class when the animation ends
  const { zoneIds: viewZoneIds, domNodes: viewZoneDoms } = createDeletedViewZonesWithRefs(
    editor,
    review.hunks,
    true
  );

  // 3. Sweep line decoration
  const sweepCollection = editor.createDecorationsCollection([
    {
      range: new monacoInstance.Range(firstLine, 1, firstLine, Number.MAX_SAFE_INTEGER),
      options: { isWholeLine: true, className: 'diff-review-sweep-line' },
    },
  ]);

  editor.revealLineInCenter(firstLine);

  // 4. Animation loop
  let currentSweepLine = firstLine;
  let cancelled = false;
  const revealedHunks = new Set<string>();

  /** Attach the revealed class to a decoration, triggering the CSS blue→green gradient */
  const withRevealedClass = (
    decs: monaco.editor.IModelDeltaDecoration[]
  ): monaco.editor.IModelDeltaDecoration[] =>
    decs.map((d) => ({
      ...d,
      options: {
        ...d.options,
        className: d.options.className
          ? `${d.options.className} diff-review-sweep-revealed`
          : d.options.className,
      },
    }));

  const finalize = () => {
    sweepCollection.clear();
    collection.set(withRevealedClass(hunksToDecorations(review.hunks, monacoInstance)));
    for (const dom of viewZoneDoms) dom.classList.remove('diff-review-sweep-pending');
  };

  const intervalMs = Math.min(30, Math.max(15, 800 / (totalLines || 1)));
  const timer = setInterval(() => {
    if (cancelled) {
      clearInterval(timer);
      return;
    }
    currentSweepLine++;

    if (currentSweepLine > lastLine) {
      clearInterval(timer);
      finalize();
      return;
    }

    // Advance the sweep line
    sweepCollection.set([
      {
        range: new monacoInstance.Range(
          currentSweepLine,
          1,
          currentSweepLine,
          Number.MAX_SAFE_INTEGER
        ),
        options: { isWholeLine: true, className: 'diff-review-sweep-line' },
      },
    ]);

    // Check whether the sweep just crossed the end of a hunk
    for (const hunk of review.hunks) {
      if (!revealedHunks.has(hunk.id) && currentSweepLine >= hunk.endLine) {
        revealedHunks.add(hunk.id);
        const updatedDecorations = hunksToDecorations(review.hunks, monacoInstance).map(
          (d, idx) => {
            const h = review.hunks[idx];
            if (h && !revealedHunks.has(h.id)) {
              // Not yet swept: translucent
              return {
                ...d,
                options: {
                  ...d.options,
                  className: d.options.className
                    ? `${d.options.className} diff-review-sweep-pending`
                    : 'diff-review-sweep-pending',
                },
              };
            }
            // Already swept: add the revealed class to trigger the gradient animation
            return {
              ...d,
              options: {
                ...d.options,
                className: d.options.className
                  ? `${d.options.className} diff-review-sweep-revealed`
                  : d.options.className,
              },
            };
          }
        );
        collection.set(updatedDecorations);
      }
    }
  }, intervalMs);

  const cancelSweep = () => {
    cancelled = true;
    clearInterval(timer);
    finalize();
  };

  return { decorationCollection: collection, viewZoneIds, reviewId: review.id, cancelSweep };
}

export function clearDiffReview(
  editor: monaco.editor.IStandaloneCodeEditor,
  state: DiffDecorationState
): void {
  if (state.cancelSweep) {
    state.cancelSweep();
  }

  if (state.decorationCollection) {
    state.decorationCollection.clear();
  }

  if (state.viewZoneIds.length > 0) {
    editor.changeViewZones((accessor) => {
      for (const id of state.viewZoneIds) {
        accessor.removeZone(id);
      }
    });
  }
}
