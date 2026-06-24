import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadHistoryDrawer } from '../../../src/renderer/src/components/chat/ThreadHistoryDrawer';
import type { ThreadSummary } from '../../../src/renderer/src/services/agent/AgentClientService';

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'thread.historyTitle': 'History',
        'thread.newThread': 'New thread',
        'thread.newConversation': 'New conversation',
        'thread.historyEmpty': 'No threads',
        'thread.rename': 'Rename',
        'thread.delete': 'Delete',
        'thread.deleteConfirm': 'Click again to delete',
        'thread.renamePlaceholder': 'Thread title',
        'thread.untitled': 'Untitled',
        'thread.turnCount': `${params?.count ?? '0'} turns`,
        'thread.noTurns': 'No turns',
        'common.cancel': 'Close',
      };
      return values[key] ?? key;
    },
  }),
}));

const threads: ThreadSummary[] = [
  {
    thread_id: 'thread-1',
    title: 'Submission edits',
    turn_count: 3,
    last_active_at: '2026-06-16T10:00:00.000Z',
  },
];

describe('ThreadHistoryDrawer', () => {
  it('labels drawer actions and keeps thread rows keyboard-focusable', () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();

    render(
      <ThreadHistoryDrawer
        open
        threads={threads}
        activeThreadId="thread-1"
        onClose={vi.fn()}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />
    );

    expect(screen.getByRole('dialog', { name: 'History' })).toBeInTheDocument();

    const create = screen.getByRole('button', { name: 'New thread' });
    expect(create).toHaveClass('cursor-pointer');
    expect(create).toHaveClass('focus-visible:ring-2');
    expect(create.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-2');

    const row = screen.getByRole('button', { name: /Submission edits/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('focus-visible:ring-2');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('thread-1');

    expect(screen.getByRole('button', { name: 'Rename' })).toHaveClass('cursor-pointer');
    const del = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(del);
    expect(screen.getByRole('button', { name: 'Click again to delete' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Click again to delete' }));
    expect(onDelete).toHaveBeenCalledWith('thread-1');
  });

  it('moves focus into the drawer and restores it when Escape closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open history
          </button>
          <ThreadHistoryDrawer
            open={open}
            threads={threads}
            activeThreadId="thread-1"
            onClose={() => setOpen(false)}
            onSelect={vi.fn()}
            onCreate={vi.fn()}
            onRename={vi.fn()}
            onDelete={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Open history' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'History' });
    expect(screen.getByRole('button', { name: 'New thread' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'History' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <ThreadHistoryDrawer
        open
        threads={threads}
        activeThreadId="thread-1"
        onClose={onClose}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'History' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps tab focus cycling inside drawer controls', () => {
    render(
      <ThreadHistoryDrawer
        open
        threads={threads}
        activeThreadId="thread-1"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'History' });
    const first = screen.getByRole('button', { name: 'New thread' });
    const last = screen.getByRole('button', { name: 'Delete' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
