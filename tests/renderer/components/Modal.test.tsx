import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../../../src/renderer/src/components/ui/Modal';

describe('Modal', () => {
  it('labels the dialog with title and description and keeps close icon decorative', () => {
    const onClose = vi.fn();

    render(
      <Modal open onClose={onClose} title="Project settings" description="Tune this workspace">
        Content
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'Project settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Tune this workspace');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog when opened and restores it when closed', () => {
    const ModalHarness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Project settings">
            Content
          </Modal>
        </>
      );
    };

    render(<ModalHarness />);

    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    fireEvent.click(opener);

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('focuses the dialog itself when no focusable child is available', () => {
    render(
      <Modal open onClose={vi.fn()} title="Read only notice" showCloseButton={false}>
        Content
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'Read only notice' });
    expect(dialog).toHaveAttribute('tabIndex', '-1');
    expect(dialog).toHaveFocus();
  });

  it('keeps tab focus cycling inside the dialog', () => {
    render(
      <Modal
        open
        onClose={vi.fn()}
        title="Project actions"
        footer={<button type="button">Apply</button>}
      >
        <button type="button">Choose folder</button>
      </Modal>
    );

    const close = screen.getByRole('button', { name: 'Close' });
    const choose = screen.getByRole('button', { name: 'Choose folder' });
    const apply = screen.getByRole('button', { name: 'Apply' });

    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(apply).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
  });
});
