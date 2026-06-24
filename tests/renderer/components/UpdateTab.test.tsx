import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../../shared/ipc/app-contract';
import { UpdateTab } from '../../../src/renderer/src/components/settings/UpdateTab';

const apiMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  onUpdateStatus: vi.fn(),
  checkUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

let updateStatusListener: ((status: UpdateStatus) => void) | null = null;

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    app: apiMocks,
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'update.currentVersion': 'Current Version',
        'update.checkUpdate': 'Check for Updates',
        'update.checking': 'Checking for updates...',
        'update.available': `New version ${params?.version ?? ''} available`,
        'update.notAvailable': 'You are up to date',
        'update.download': 'Download Update',
        'update.downloaded': 'Update ready to install',
        'update.installAndRestart': 'Install and Restart',
        'update.error': `Update check failed: ${params?.error ?? ''}`,
        'update.retryCheck': 'Retry',
        'update.releaseNotes': 'Release Notes',
      };
      return values[key] ?? key;
    },
  }),
}));

function mockStatusPush(status: UpdateStatus): void {
  apiMocks.onUpdateStatus.mockImplementation((listener: (status: UpdateStatus) => void) => {
    updateStatusListener = listener;
    listener(status);
    return () => {
      updateStatusListener = null;
    };
  });
}

describe('UpdateTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateStatusListener = null;
    apiMocks.getVersion.mockResolvedValue('0.3.0');
    apiMocks.onUpdateStatus.mockImplementation((listener: (status: UpdateStatus) => void) => {
      updateStatusListener = listener;
      return () => {
        updateStatusListener = null;
      };
    });
    apiMocks.checkUpdate.mockResolvedValue({ state: 'not-available', currentVersion: '0.3.0' });
    apiMocks.downloadUpdate.mockResolvedValue(undefined);
  });

  it('keeps update actions discoverable with pointer, focus, and hidden decorative icons', async () => {
    render(<UpdateTab />);

    const check = await screen.findByRole('button', { name: 'Check for Updates' });
    expect(check).toHaveClass('cursor-pointer');
    expect(check).toHaveClass('focus-visible:ring-2');
    expect(check.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(check);
    await waitFor(() => expect(apiMocks.checkUpdate).toHaveBeenCalledTimes(1));
  });

  it('renders download and install actions with consistent keyboard affordances', async () => {
    mockStatusPush({
      state: 'available',
      currentVersion: '0.3.0',
      info: { version: '0.4.0', releaseNotes: 'Polish notes' },
    });

    render(<UpdateTab />);

    const download = await screen.findByRole('button', { name: 'Download Update' });
    expect(download).toHaveClass('cursor-pointer');
    expect(download).toHaveClass('focus-visible:ring-2');
    expect(download.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(download);
    expect(apiMocks.downloadUpdate).toHaveBeenCalledTimes(1);

    act(() => {
      updateStatusListener?.({ state: 'downloaded', currentVersion: '0.3.0' });
    });

    const install = await screen.findByRole('button', { name: 'Install and Restart' });
    expect(install).toHaveClass('cursor-pointer');
    expect(install).toHaveClass('focus-visible:ring-2');
    expect(install.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
