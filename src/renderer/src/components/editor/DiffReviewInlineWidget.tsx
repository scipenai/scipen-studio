/**
 * @file DiffReviewInlineWidget.tsx — Inline Diff Review action buttons
 * @description
 *   1. Anchor each hunk's action buttons next to the code change rather than pinning them to the editor edge.
 *   2. Offer a lightweight popover previewing before/after snippets so users don't have to scan back and forth.
 *   3. The top-level status bar lives in EditorToolbar; this component only owns line-level interactions.
 */

import { Check, X } from 'lucide-react';
import type React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { t } from '../../locales';
import type { PendingReview, DiffHunk } from '../../services/core/DiffReviewService';

interface DiffReviewInlineWidgetProps {
  review: PendingReview;
  editor: monaco.editor.IStandaloneCodeEditor;
  monacoInstance: Monaco;
  onAcceptHunk: (hunkId: string) => void;
  onRejectHunk: (hunkId: string) => void;
  disabled?: boolean;
}

interface HunkWidgetPosition {
  top: number;
  left: number;
  popoverDirection: 'open-left' | 'open-right';
  popoverWidth: number;
}

function hunkTypeIndicator(hunk: DiffHunk): { label: string; color: string } {
  switch (hunk.type) {
    case 'added':
      return { label: '+', color: 'var(--color-success, #28a745)' };
    case 'removed':
      return { label: '-', color: 'var(--color-error, #dc3545)' };
    case 'modified':
      return { label: '~', color: 'var(--color-warning, #f59e0b)' };
  }
}

function getPreviewTitle(hunk: DiffHunk): string {
  switch (hunk.type) {
    case 'added':
      return t('diffReview.addedSnippet');
    case 'removed':
      return t('diffReview.removedSnippet');
    case 'modified':
      return t('diffReview.modifiedSnippet');
  }
}

function clampLine(model: monaco.editor.ITextModel, lineNumber: number): number {
  return Math.max(1, Math.min(model.getLineCount(), lineNumber));
}

function trimPreviewText(text: string, maxLines = 6): string {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) {
    return normalized || ' ';
  }
  return `${lines.slice(0, maxLines).join('\n')}\n…`;
}

export const DiffReviewInlineWidget: React.FC<DiffReviewInlineWidgetProps> = memo(
  ({ review, editor, onAcceptHunk, onRejectHunk, disabled = false }) => {
    const [hunkPositions, setHunkPositions] = useState<Map<string, HunkWidgetPosition>>(new Map());
    const [expandedHunkId, setExpandedHunkId] = useState<string | null>(null);
    const rafRef = useRef<number>(0);

    useEffect(() => {
      const updatePositions = () => {
        const model = editor.getModel();
        if (!model) {
          setHunkPositions(new Map());
          return;
        }

        const map = new Map<string, HunkWidgetPosition>();
        const layoutInfo = editor.getLayoutInfo();
        const editorContainer = editor.getContainerDomNode();
        const containerWidth = editorContainer.clientWidth;
        const widgetWidth = 112;
        const minLeft = layoutInfo.contentLeft + 8;
        const maxLeft = layoutInfo.contentLeft + layoutInfo.contentWidth - widgetWidth - 12;
        const preferredPopoverWidth = 360;
        const minPopoverWidth = 260;
        const popoverGap = 12;
        const edgePadding = 16;

        for (const hunk of review.hunks) {
          const anchorLine = clampLine(
            model,
            hunk.type === 'removed' ? hunk.startLine : Math.max(hunk.startLine, hunk.endLine)
          );
          const anchorColumn = Math.max(1, model.getLineMaxColumn(anchorLine));
          const visiblePosition = editor.getScrolledVisiblePosition({
            lineNumber: anchorLine,
            column: anchorColumn,
          });

          const top = visiblePosition?.top ?? editor.getTopForLineNumber(anchorLine);
          const left = visiblePosition
            ? Math.max(minLeft, Math.min(visiblePosition.left + 18, maxLeft))
            : minLeft;

          const rightSpace = containerWidth - left - widgetWidth - edgePadding;
          const leftSpace = left - edgePadding;
          const maxPopoverWidth = Math.max(
            minPopoverWidth,
            Math.min(preferredPopoverWidth, containerWidth - edgePadding * 2)
          );
          const shouldOpenRight =
            rightSpace >= maxPopoverWidth ||
            (rightSpace >= minPopoverWidth && rightSpace >= leftSpace);
          const availableDirectionSpace = shouldOpenRight ? rightSpace : leftSpace;
          const popoverWidth = Math.max(
            minPopoverWidth,
            Math.min(maxPopoverWidth, availableDirectionSpace - popoverGap)
          );

          map.set(hunk.id, {
            top,
            left,
            popoverDirection: shouldOpenRight ? 'open-right' : 'open-left',
            popoverWidth,
          });
        }

        setHunkPositions(map);
      };

      updatePositions();

      const scheduleUpdate = () => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updatePositions);
      };

      const d1 = editor.onDidScrollChange(scheduleUpdate);
      const d2 = editor.onDidLayoutChange(scheduleUpdate);
      const d3 = editor.onDidChangeModelContent(scheduleUpdate);

      return () => {
        cancelAnimationFrame(rafRef.current);
        d1.dispose();
        d2.dispose();
        d3.dispose();
      };
    }, [editor, review.hunks]);

    useEffect(() => {
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest('.diff-review-hunk-inline')) {
          setExpandedHunkId(null);
        }
      };

      window.addEventListener('pointerdown', handlePointerDown, true);
      return () => window.removeEventListener('pointerdown', handlePointerDown, true);
    }, []);

    return (
      <div className="diff-review-inline-container">
        {review.hunks.map((hunk) => {
          const position = hunkPositions.get(hunk.id);
          if (!position) return null;

          const indicator = hunkTypeIndicator(hunk);
          const isExpanded = expandedHunkId === hunk.id;
          const showBelow = position.top < 110;

          return (
            <div
              key={hunk.id}
              className="diff-review-hunk-inline"
              style={{ top: position.top, left: position.left }}
            >
              <button
                type="button"
                className="diff-review-hunk-inline__preview"
                title={t('diffReview.previewChange')}
                onClick={() =>
                  setExpandedHunkId((current) => (current === hunk.id ? null : hunk.id))
                }
                disabled={disabled}
              >
                <span className="diff-review-hunk-inline__type" style={{ color: indicator.color }}>
                  {indicator.label}
                </span>
              </button>
              <button
                type="button"
                className="diff-review-hunk-inline__btn diff-review-hunk-inline__btn--accept"
                onClick={() => onAcceptHunk(hunk.id)}
                title={t('diffReview.accept')}
                disabled={disabled}
              >
                <Check size={11} strokeWidth={2.5} />
              </button>
              <button
                type="button"
                className="diff-review-hunk-inline__btn diff-review-hunk-inline__btn--reject"
                onClick={() => onRejectHunk(hunk.id)}
                title={t('diffReview.reject')}
                disabled={disabled}
              >
                <X size={11} strokeWidth={2.5} />
              </button>

              {isExpanded && (
                <div
                  className={`diff-review-hunk-popover${
                    showBelow ? ' diff-review-hunk-popover--below' : ''
                  }${
                    position.popoverDirection === 'open-right'
                      ? ' diff-review-hunk-popover--right'
                      : ' diff-review-hunk-popover--left'
                  }`}
                  style={{ width: `${position.popoverWidth}px` }}
                >
                  <div className="diff-review-hunk-popover__title">{getPreviewTitle(hunk)}</div>
                  {hunk.originalText ? (
                    <div className="diff-review-hunk-popover__section">
                      <div className="diff-review-hunk-popover__label">
                        {t('diffReview.originalVersion')}
                      </div>
                      <pre className="diff-review-hunk-popover__code diff-review-hunk-popover__code--removed">
                        {trimPreviewText(hunk.originalText)}
                      </pre>
                    </div>
                  ) : null}
                  {hunk.newText ? (
                    <div className="diff-review-hunk-popover__section">
                      <div className="diff-review-hunk-popover__label">
                        {t('diffReview.proposedVersion')}
                      </div>
                      <pre className="diff-review-hunk-popover__code diff-review-hunk-popover__code--added">
                        {trimPreviewText(hunk.newText)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
);

DiffReviewInlineWidget.displayName = 'DiffReviewInlineWidget';
