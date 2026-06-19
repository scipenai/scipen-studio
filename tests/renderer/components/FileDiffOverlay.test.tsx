import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileDiffOverlay } from '../../../src/renderer/src/components/history/FileDiffOverlay';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'history.diffOverlayTitle': `Diff for ${params?.fileId ?? 'file'}`,
        'history.close': 'Close',
        'history.diffStatsClosed': 'Closed',
        'history.diffStatsNoChange': 'No changes',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('FileDiffOverlay', () => {
  it('renders a labelled modal with focusable close controls and decorative icons hidden', () => {
    const onClose = vi.fn();

    render(
      <FileDiffOverlay
        fileId="src/main.tex"
        beforeText={'one\nold'}
        afterText={'one\nnew'}
        onClose={onClose}
      />
    );

    expect(screen.getByRole('dialog', { name: 'Diff for src/main.tex' })).toBeInTheDocument();

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons).toHaveLength(2);
    for (const button of closeButtons) {
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveClass('cursor-pointer');
      expect(button).toHaveClass('focus-visible:ring-2');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus into the overlay and restores it when Escape closes', () => {
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            View diff
          </button>
          {open ? (
            <FileDiffOverlay
              fileId="src/main.tex"
              beforeText="one"
              afterText="two"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'View diff' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Diff for src/main.tex' });
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons[0]).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Diff for src/main.tex' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('keeps tab focus cycling inside overlay controls', () => {
    render(
      <FileDiffOverlay fileId="src/main.tex" beforeText="one" afterText="two" onClose={vi.fn()} />
    );

    const dialog = screen.getByRole('dialog', { name: 'Diff for src/main.tex' });
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });

    expect(closeButtons[0]).toHaveFocus();

    closeButtons[1].focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(closeButtons[0]).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(closeButtons[1]).toHaveFocus();
  });
});
