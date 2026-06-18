import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BibTexSyncSection } from '../../../src/renderer/src/components/settings/BibTexSyncSection';

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getSettings: vi.fn().mockResolvedValue({
        bibTexSync: {
          enabled: true,
          fileName: '.scipen/references.bib',
          translator: 'BetterBibLaTeX',
        },
      }),
      onSettingsChanged: vi.fn(() => vi.fn()),
      getBibTexSyncStatus: vi.fn().mockResolvedValue({ kind: 'idle' }),
      setSettings: vi.fn(),
      syncBibTex: vi.fn().mockResolvedValue({ kind: 'ok' }),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroSettings.bibtexSync.title': 'references.bib auto-sync',
        'zoteroSettings.bibtexSync.description': 'Sync bibliography',
        'zoteroSettings.bibtexSync.enable': 'Enable auto-sync',
        'zoteroSettings.bibtexSync.enableDesc': 'Writes a bib file',
        'zoteroSettings.bibtexSync.fileName': 'Target file name',
        'zoteroSettings.bibtexSync.fileNameDesc': 'Generated under root',
        'zoteroSettings.bibtexSync.translator': 'BibTeX flavor',
        'zoteroSettings.bibtexSync.translatorDesc': 'Pick translator',
        'zoteroSettings.bibtexSync.syncNow': 'Sync now',
        'zoteroSettings.bibtexSync.hintTitle': 'Add this line',
        'zoteroSettings.bibtexSync.hintDesc': 'Do not edit by hand',
        'zoteroSettings.bibtexSync.status.idle': 'Idle',
        'zoteroSettings.bibtexSync.status.syncing': 'Syncing',
        'zoteroSettings.bibtexSync.status.ok': 'Synced',
        'zoteroSettings.bibtexSync.status.skipped': 'Skipped',
        'zoteroSettings.bibtexSync.status.conflict': 'Conflict',
        'zoteroSettings.bibtexSync.status.error': 'Error',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('BibTexSyncSection', () => {
  it('connects form labels and keeps manual sync focusable', async () => {
    render(<BibTexSyncSection />);

    expect(await screen.findByLabelText('Target file name')).toHaveClass('focus-visible:ring-1');
    expect(screen.getByLabelText('BibTeX flavor')).toHaveClass('focus-visible:ring-1');

    const sync = screen.getByRole('button', { name: 'Sync now' });
    expect(sync).toHaveClass('cursor-pointer');
    expect(sync).toHaveClass('focus-visible:ring-2');
    expect(sync.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
