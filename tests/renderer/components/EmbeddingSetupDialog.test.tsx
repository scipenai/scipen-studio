import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingSetupDialog } from '../../../src/renderer/src/components/onboarding/EmbeddingSetupDialog';

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
      setSettings: vi.fn().mockResolvedValue(undefined),
      setEmbeddingApiKey: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroEmbedding.dialog.title': 'Set up recommendations',
        'zoteroEmbedding.dialog.privacyTitle': 'Privacy notice',
        'zoteroEmbedding.dialog.privacyBody': 'Sends paragraph text to provider.',
        'zoteroEmbedding.dialog.providerLabel': 'Embedding provider',
        'zoteroEmbedding.provider.zhipu': 'Zhipu',
        'zoteroEmbedding.provider.aliyun': 'Aliyun',
        'zoteroEmbedding.provider.openai': 'OpenAI',
        'zoteroEmbedding.dialog.keyLabel': 'API Key',
        'zoteroEmbedding.dialog.keyPlaceholder': 'Paste API key',
        'zoteroEmbedding.dialog.consent': 'I understand and agree',
        'zoteroEmbedding.dialog.cancel': 'Cancel',
        'zoteroEmbedding.dialog.save': 'Save and enable',
        'zoteroEmbedding.dialog.showKey': 'Show key',
        'zoteroEmbedding.dialog.hideKey': 'Hide key',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('EmbeddingSetupDialog', () => {
  it('renders provider choices and key controls with accessible state', () => {
    render(<EmbeddingSetupDialog open onClose={vi.fn()} onConfirmed={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Set up recommendations' })).toHaveAttribute(
      'aria-modal',
      'true'
    );

    expect(screen.getByRole('radiogroup', { name: 'Embedding provider' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Zhipu' })).toHaveAttribute('aria-checked', 'true');
    const openai = screen.getByRole('radio', { name: 'OpenAI' });
    expect(openai).toHaveClass('cursor-pointer');
    expect(openai).toHaveClass('focus-visible:ring-2');
    fireEvent.click(openai);
    expect(openai).toHaveAttribute('aria-checked', 'true');

    const input = screen.getByLabelText('API Key');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveClass('focus-visible:ring-1');

    const reveal = screen.getByRole('button', { name: 'Show key' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    expect(reveal).toHaveClass('cursor-pointer');
    expect(reveal).toHaveClass('focus-visible:ring-2');

    fireEvent.click(reveal);
    expect(screen.getByRole('button', { name: 'Hide key' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    expect(screen.getByRole('button', { name: 'Save and enable' })).toBeDisabled();
  });

  it('moves focus into the dialog, restores it on Escape, and traps Tab', () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Configure recommendations
          </button>
          <EmbeddingSetupDialog open={open} onClose={() => setOpen(false)} onConfirmed={vi.fn()} />
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Configure recommendations' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Set up recommendations' });
    const first = screen.getByRole('button', { name: 'common.close' });
    const last = screen.getByRole('button', { name: 'Cancel' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(
      screen.queryByRole('dialog', { name: 'Set up recommendations' })
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
