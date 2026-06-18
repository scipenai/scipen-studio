import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceDrawer } from '../../../src/renderer/src/components/layout/workspace/WorkspaceDrawer';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

describe('WorkspaceDrawer', () => {
  it('renders the backdrop close affordance as a named keyboard-visible button', () => {
    const onClose = vi.fn();

    render(
      <WorkspaceDrawer open onClose={onClose} closeAriaLabel="Close file drawer">
        Drawer content
      </WorkspaceDrawer>
    );

    const close = screen.getByRole('button', { name: 'Close file drawer' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-2');

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('presents the drawer as a labelled dialog and restores focus after Escape closes it', () => {
    const DrawerHarness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open file drawer
          </button>
          <WorkspaceDrawer
            open={open}
            onClose={() => setOpen(false)}
            closeAriaLabel="Close file drawer"
          >
            <button type="button">Create file</button>
          </WorkspaceDrawer>
        </>
      );
    };

    render(<DrawerHarness />);

    const opener = screen.getByRole('button', { name: 'Open file drawer' });
    opener.focus();
    fireEvent.click(opener);

    const drawer = screen.getByRole('dialog', { name: 'Close file drawer' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Create file' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Close file drawer' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('keeps tab focus cycling inside the drawer', () => {
    render(
      <WorkspaceDrawer open onClose={vi.fn()} closeAriaLabel="Close file drawer">
        <button type="button">Create file</button>
        <button type="button">Refresh files</button>
      </WorkspaceDrawer>
    );

    const create = screen.getByRole('button', { name: 'Create file' });
    const refresh = screen.getByRole('button', { name: 'Refresh files' });
    expect(create).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(refresh).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(create).toHaveFocus();
  });
});
