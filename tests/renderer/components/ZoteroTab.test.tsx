import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoteroTab } from '../../../src/renderer/src/components/settings/ZoteroTab';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  getDiagnostics: vi.fn(),
  detectInstallation: vi.fn(),
}));

const mirrorMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

const wizardMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

let zoteroEnabled = true;

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: apiMocks,
  },
}));

vi.mock('../../../src/renderer/src/hooks/useZoteroBibMirror', () => ({
  useZoteroBibMirror: () => ({
    enabled: zoteroEnabled,
    mirror: mirrorMocks,
    state: {
      status: 'ready',
      itemCount: 24,
      lastSyncedAt: '2026-06-16T10:00:00.000Z',
    },
  }),
}));

vi.mock('../../../src/renderer/src/hooks/useZoteroWizard', () => ({
  useZoteroWizard: () => ({
    isOpen: false,
    currentStep: 1,
    open: wizardMocks.open,
    close: vi.fn(),
    goNext: vi.fn(),
    goBack: vi.fn(),
    recheckZotero: vi.fn(),
    recheckLocalApi: vi.fn(),
    recheckBBT: vi.fn(),
    skipBBT: vi.fn(),
    finish: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/components/onboarding/ZoteroSetupWizard', () => ({
  ZoteroSetupWizard: () => null,
}));

vi.mock('../../../src/renderer/src/components/settings/BibTexSyncSection', () => ({
  BibTexSyncSection: () => <div data-testid="bibtex-sync" />,
}));

vi.mock('../../../src/renderer/src/components/settings/EmbeddingRecommendationSection', () => ({
  EmbeddingRecommendationSection: () => <div data-testid="embedding-recommendations" />,
}));

vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroSettings.title': 'Zotero',
        'zoteroSettings.subtitle': 'Manage library integration',
        'zoteroSettings.basicSettings': 'Basic settings',
        'zoteroSettings.enableIntegration': 'Connect Zotero library',
        'zoteroSettings.enableIntegrationDesc': 'Index your library',
        'zoteroSettings.notEnabledTitle': 'Not enabled',
        'zoteroSettings.notEnabledDesc': 'Set up Zotero',
        'zoteroSettings.startWizard': 'Open setup wizard',
        'zoteroSettings.indexStatus': 'Index status',
        'zoteroSettings.itemCount': 'Items',
        'zoteroSettings.lastSyncedAt': 'Last sync',
        'zoteroSettings.never': 'Never',
        'zoteroSettings.sources': 'Sources',
        'zoteroSettings.localApi': 'Zotero Local API',
        'zoteroSettings.betterBibTex': 'Better BibTeX',
        'zoteroSettings.actions': 'Actions',
        'zoteroSettings.refreshNow': 'Refresh now',
        'zoteroSettings.refreshNowDesc': 'Reload items',
        'zoteroSettings.reopenWizard': 'Reopen wizard',
        'zoteroSettings.reopenWizardDesc': 'Run setup again',
        'zoteroSettings.redetect': 'Redetect installation',
        'zoteroSettings.redetectDesc': 'Check installation path',
        'zoteroSettings.execute': 'Run',
        'zoteroSettings.busy': 'Working',
        'zotero.status.ready': 'Ready',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('ZoteroTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    zoteroEnabled = true;
    apiMocks.getSettings.mockResolvedValue({
      integrationEnabled: zoteroEnabled,
      localApiEnabled: true,
    });
    apiMocks.setSettings.mockResolvedValue(undefined);
    apiMocks.getDiagnostics.mockResolvedValue({
      sources: {
        localApi: { ok: true },
        betterBibTex: { ok: true },
      },
    });
    apiMocks.detectInstallation.mockResolvedValue({ found: true });
    mirrorMocks.refresh.mockResolvedValue(undefined);
  });

  it('labels the integration switch and keeps setup entry action focusable', async () => {
    zoteroEnabled = false;

    render(<ZoteroTab />);

    const toggle = screen.getByRole('switch', { name: 'Connect Zotero library' });
    expect(toggle).toHaveClass('cursor-pointer');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(apiMocks.setSettings).toHaveBeenCalledWith({ integrationEnabled: true });

    const setup = screen.getByRole('button', { name: 'Open setup wizard' });
    expect(setup).toHaveClass('cursor-pointer');
    expect(setup).toHaveClass('focus-visible:ring-2');
    expect(setup.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders enabled actions with accessible names, focus feedback, and disabled affordance', async () => {
    render(<ZoteroTab />);

    const refresh = screen.getByRole('button', { name: 'Refresh now' });
    expect(refresh).toHaveClass('cursor-pointer');
    expect(refresh).toHaveClass('focus-visible:ring-2');
    expect(refresh.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(refresh);
    await waitFor(() => expect(mirrorMocks.refresh).toHaveBeenCalledTimes(1));
    expect(apiMocks.getDiagnostics).toHaveBeenCalled();

    const reopen = screen.getByRole('button', { name: 'Reopen wizard' });
    fireEvent.click(reopen);
    expect(wizardMocks.open).toHaveBeenCalledTimes(1);

    const redetect = screen.getByRole('button', { name: 'Redetect installation' });
    expect(redetect).toHaveClass('cursor-pointer');
    fireEvent.click(redetect);
    await waitFor(() => expect(apiMocks.detectInstallation).toHaveBeenCalledTimes(1));
  });
});
