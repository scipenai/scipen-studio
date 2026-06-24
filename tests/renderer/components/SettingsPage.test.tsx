import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../../src/renderer/src/components/pages/SettingsPage';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/hooks/useLazyModule', () => ({
  useLazyModule: () => () => <button type="button">Settings content action</button>,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'settingsPanel.title': 'Settings',
        'settingsPanel.description': 'Tune the workspace',
        'settingsPanel.close': 'Close settings',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('SettingsPage', () => {
  it('presents settings as a labelled modal surface with a focus-visible close action', () => {
    const onClose = vi.fn();

    render(<SettingsPage onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-2');
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into settings and restores it when Escape closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
          {open ? <SettingsPage onClose={() => setOpen(false)} /> : null}
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('keeps tab focus cycling inside settings controls', () => {
    render(<SettingsPage onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const first = screen.getByRole('button', { name: 'Close settings' });
    const last = screen.getByRole('button', { name: 'Settings content action' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
