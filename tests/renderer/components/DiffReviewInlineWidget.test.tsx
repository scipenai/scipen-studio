import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffReviewInlineWidget } from '../../../src/renderer/src/components/editor/DiffReviewInlineWidget';
import type { PendingReview } from '../../../src/renderer/src/services/core/DiffReviewService';

vi.mock('../../../src/renderer/src/locales', () => ({
  t: (key: string) => {
    const values: Record<string, string> = {
      'diffReview.accept': 'Accept',
      'diffReview.reject': 'Reject',
      'diffReview.previewChange': 'Preview change',
      'diffReview.modifiedSnippet': 'Modified snippet',
      'diffReview.originalVersion': 'Original version',
      'diffReview.proposedVersion': 'Proposed version',
    };
    return values[key] ?? key;
  },
}));

function createEditor() {
  const model = {
    getLineCount: vi.fn(() => 8),
    getLineMaxColumn: vi.fn(() => 48),
  };

  return {
    getModel: vi.fn(() => model),
    getLayoutInfo: vi.fn(() => ({ contentLeft: 32, contentWidth: 560 })),
    getContainerDomNode: vi.fn(() => ({ clientWidth: 720 })),
    getScrolledVisiblePosition: vi.fn(() => ({ top: 120, left: 420 })),
    getTopForLineNumber: vi.fn(() => 120),
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

const review: PendingReview = {
  id: 'review-1',
  reviewKey: { backend: 'local', projectId: 'D:/paper', fileId: 'main.tex' },
  fileId: 'main.tex',
  filePath: 'main.tex',
  normalizedFilePath: 'main.tex',
  hunks: [
    {
      id: 'hunk-1',
      type: 'modified',
      startLine: 2,
      endLine: 3,
      originalText: 'Old claim',
      newText: 'Sharper claim',
    },
  ],
  originalFullContent: 'Old claim',
  newFullContent: 'Sharper claim',
  timestamp: 1,
};

describe('DiffReviewInlineWidget', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('exposes hunk actions and preview popover with accessible state', async () => {
    render(
      <DiffReviewInlineWidget
        review={review}
        editor={createEditor() as never}
        monacoInstance={{} as never}
        onAcceptHunk={vi.fn()}
        onRejectHunk={vi.fn()}
      />
    );

    const preview = await screen.findByRole('button', { name: 'Preview change' });
    expect(preview).toHaveAttribute('aria-expanded', 'false');
    expect(preview).toHaveAttribute('aria-controls', 'diff-review-hunk-popover-hunk-1');

    expect(screen.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-label', 'Accept');
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveAttribute('aria-label', 'Reject');

    fireEvent.click(preview);

    expect(preview).toHaveAttribute('aria-expanded', 'true');
    const popover = screen.getByRole('dialog', { name: 'Modified snippet' });
    expect(popover).toHaveAttribute('id', 'diff-review-hunk-popover-hunk-1');
    expect(popover).toHaveTextContent('Original version');
    expect(popover).toHaveTextContent('Proposed version');
  });

  it('moves focus into the preview popover and restores it when Escape closes', async () => {
    render(
      <DiffReviewInlineWidget
        review={review}
        editor={createEditor() as never}
        monacoInstance={{} as never}
        onAcceptHunk={vi.fn()}
        onRejectHunk={vi.fn()}
      />
    );

    const preview = await screen.findByRole('button', { name: 'Preview change' });
    preview.focus();
    fireEvent.click(preview);

    const popover = screen.getByRole('dialog', { name: 'Modified snippet' });
    expect(popover).toHaveFocus();

    fireEvent.keyDown(popover, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Modified snippet' })).not.toBeInTheDocument();
    expect(preview).toHaveFocus();
  });
});
