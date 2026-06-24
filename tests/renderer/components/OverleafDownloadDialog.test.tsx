import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OverleafDownloadDialog } from '../../../src/renderer/src/components/OverleafDownloadDialog';

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
    overleaf: {
      getProjects: vi.fn().mockResolvedValue([]),
      login: vi.fn().mockResolvedValue({ success: true }),
      downloadProject: vi.fn(),
      getProjectDetails: vi.fn(),
    },
    project: {
      openByPath: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getEditorService: () => ({ addTab: vi.fn() }),
  getSettingsService: () => ({
    updateCompiler: vi.fn(),
  }),
  useCompilerSettings: () => ({
    overleaf: {
      serverUrl: '',
      cookies: '',
    },
  }),
}));

vi.mock('../../../src/renderer/src/services/core/FileOpenService', () => ({
  bootstrapProject: vi.fn(),
}));

vi.mock('../../../src/renderer/src/components/welcomeScreenHelpers', () => ({
  cleanupStaleTabs: vi.fn(),
  findFileNodeId: vi.fn(),
  resetWorkspaceToChat: vi.fn(),
}));

vi.mock('../../../src/renderer/src/utils', () => ({
  formatTimeAgo: () => 'just now',
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'common.error': 'Error',
        'common.refresh': 'Refresh',
        'welcome.openProjectFailed': 'Failed to open project',
        'welcome.remoteDialog.title': 'Open Remote Project',
        'welcome.remoteDialog.subtitle': 'Connect to Overleaf',
        'welcome.remoteDialog.configRequired': 'Overleaf Connection Required',
        'welcome.remoteDialog.configHint': 'Fill in credentials',
        'welcome.remoteDialog.serverUrl': 'Server URL',
        'welcome.remoteDialog.serverUrlHint': 'Official or private server',
        'welcome.remoteDialog.cookies': 'Cookies',
        'welcome.remoteDialog.showCookies': 'Show cookies',
        'welcome.remoteDialog.hideCookies': 'Hide cookies',
        'welcome.remoteDialog.cookiesRequired': 'Please enter Overleaf Cookie',
        'welcome.remoteDialog.connect': 'Connect Overleaf',
        'welcome.remoteDialog.connecting': 'Connecting',
        'welcome.remoteDialog.cookieExpired': 'Cookie may have expired',
        'welcome.remoteDialog.projectCount': `${params?.count ?? 0} projects`,
        'welcome.remoteDialog.loadingProjects': 'Loading',
        'welcome.remoteDialog.noProjects': 'No projects found',
        'welcome.remoteDialog.updatedAt': 'Updated',
        'welcome.remoteDialog.openInBrowser': 'Open in browser',
        'welcome.remoteDialog.openProject': 'Open Project',
        'welcome.remoteDialog.opening': 'Opening',
        'welcome.remoteDialog.reconfigure': 'Reconfigure',
        'welcome.remoteDialog.retryConnect': 'Retry Connection',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('OverleafDownloadDialog', () => {
  it('renders cookie setup as a labelled dialog with connected secure inputs', () => {
    render(<OverleafDownloadDialog open onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Open Remote Project' })).toHaveAttribute(
      'aria-modal',
      'true'
    );

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-2');
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const serverUrl = screen.getByLabelText('Server URL');
    expect(serverUrl).toHaveClass('focus-visible:ring-2');

    const cookies = screen.getByLabelText('Cookies');
    expect(cookies).toHaveAttribute('type', 'password');
    expect(cookies).toHaveClass('focus-visible:ring-2');

    const reveal = screen.getByRole('button', { name: 'Show cookies' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    expect(reveal).toHaveClass('cursor-pointer');
    expect(reveal.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(reveal);
    expect(screen.getByRole('button', { name: 'Hide cookies' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(cookies).toHaveAttribute('type', 'text');

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('focus-visible:ring-2');
    expect(screen.getByRole('button', { name: 'Connect Overleaf' })).toBeDisabled();
  });

  it('moves focus into the dialog, traps Tab, closes with Escape, and restores focus', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open remote dialog
          </button>
          <OverleafDownloadDialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Open remote dialog' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Open Remote Project' });
    const close = screen.getByRole('button', { name: 'Close' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Open Remote Project' })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
