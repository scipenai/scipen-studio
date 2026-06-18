import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MinerUSetupDialog } from '../../../src/renderer/src/components/onboarding/MinerUSetupDialog';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      setMinerUApiKey: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroMineru.dialog.title': 'Configure MinerU',
        'zoteroMineru.dialog.privacyTitle': 'Privacy notice',
        'zoteroMineru.dialog.privacyBody': 'Uploads this PDF for parsing.',
        'zoteroMineru.dialog.tokenLabel': 'MinerU API Token',
        'zoteroMineru.dialog.tokenPlaceholder': 'Paste token',
        'zoteroMineru.dialog.consent': 'I understand and agree',
        'zoteroMineru.dialog.cancel': 'Cancel',
        'zoteroMineru.dialog.save': 'Save and parse',
        'zoteroMineru.dialog.showToken': 'Show token',
        'zoteroMineru.dialog.hideToken': 'Hide token',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('MinerUSetupDialog', () => {
  it('renders as a labelled privacy dialog with connected form controls', () => {
    render(<MinerUSetupDialog open onClose={vi.fn()} onConfirmed={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Configure MinerU' })).toHaveAttribute(
      'aria-modal',
      'true'
    );

    const input = screen.getByLabelText('MinerU API Token');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveClass('focus-visible:ring-1');

    const reveal = screen.getByRole('button', { name: 'Show token' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    expect(reveal).toHaveClass('cursor-pointer');
    expect(reveal).toHaveClass('focus-visible:ring-2');
    expect(reveal.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(reveal);
    expect(screen.getByRole('button', { name: 'Hide token' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(input).toHaveAttribute('type', 'text');

    for (const label of ['Cancel', 'Save and parse']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toHaveClass('focus-visible:ring-2');
    }
    expect(screen.getByRole('button', { name: 'Save and parse' })).toBeDisabled();
  });

  it('moves focus into the dialog, restores it on Escape, and traps Tab', () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Configure MinerU token
          </button>
          <MinerUSetupDialog open={open} onClose={() => setOpen(false)} onConfirmed={vi.fn()} />
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Configure MinerU token' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Configure MinerU' });
    const first = screen.getByRole('button', { name: 'common.close' });
    const last = screen.getByRole('button', { name: 'Cancel' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Configure MinerU' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
