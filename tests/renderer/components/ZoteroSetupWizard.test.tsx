import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ZoteroSetupWizard } from '../../../src/renderer/src/components/onboarding/ZoteroSetupWizard';
import type { ZoteroWizardController } from '../../../src/renderer/src/hooks/useZoteroWizard';

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
    app: {
      openExternal: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'common.close': 'Close',
        'zoteroWizard.title': 'Connect Zotero',
        'zoteroWizard.subtitle': 'Finish setup',
        'zoteroWizard.stepLabel': `Step ${params?.current ?? 1} of ${params?.total ?? 3}`,
        'zoteroWizard.back': 'Back',
        'zoteroWizard.next': 'Next',
        'zoteroWizard.finish': 'Finish',
        'zoteroWizard.checking': 'Checking',
        'zoteroWizard.step1.title': 'Is Zotero installed?',
        'zoteroWizard.step1.missingTitle': 'Zotero not found',
        'zoteroWizard.step1.missingHint': 'Install Zotero first.',
        'zoteroWizard.step1.downloadLink': 'Download from zotero.org',
        'zoteroWizard.step1.haveInstalledBtn': 'I just installed it',
      };
      return values[key] ?? key;
    },
  }),
}));

const createController = (
  overrides: Partial<ZoteroWizardController> = {}
): ZoteroWizardController => ({
  isOpen: true,
  currentStep: 1,
  zoteroStep: { status: 'missing' },
  detection: null,
  localApiStep: { status: 'idle' },
  pingResult: null,
  bbtStep: { status: 'idle' },
  skippedBBT: false,
  settings: null,
  open: vi.fn(),
  close: vi.fn(),
  goNext: vi.fn(),
  goBack: vi.fn(),
  recheckZotero: vi.fn().mockResolvedValue(undefined),
  recheckLocalApi: vi.fn().mockResolvedValue(undefined),
  recheckBBT: vi.fn().mockResolvedValue(undefined),
  skipBBT: vi.fn(),
  finish: vi.fn(),
  ...overrides,
});

describe('ZoteroSetupWizard', () => {
  it('renders the setup flow as a labelled dialog with focusable actions', () => {
    render(<ZoteroSetupWizard controller={createController()} />);

    expect(screen.getByRole('dialog', { name: 'Connect Zotero' })).toHaveAttribute(
      'aria-modal',
      'true'
    );

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-2');
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const download = screen.getByRole('button', { name: 'Download from zotero.org' });
    expect(download).toHaveClass('cursor-pointer');
    expect(download).toHaveClass('focus-visible:ring-2');
    expect(download.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const retry = screen.getByRole('button', { name: 'I just installed it' });
    expect(retry).toHaveClass('cursor-pointer');
    expect(retry).toHaveClass('focus-visible:ring-2');
    expect(retry.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    expect(back).toHaveClass('disabled:cursor-not-allowed');
    expect(back.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    expect(screen.getByRole('button', { name: 'Next' })).toHaveClass('focus-visible:ring-2');
  });

  it('moves focus into the wizard, restores it on Escape, and traps Tab', () => {
    const close = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const controller = createController({
        isOpen: open,
        close: () => {
          close();
          setOpen(false);
        },
      });

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open Zotero setup
          </button>
          <ZoteroSetupWizard controller={controller} />
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Open Zotero setup' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Connect Zotero' });
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'I just installed it' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Connect Zotero' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
