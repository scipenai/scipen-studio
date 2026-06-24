import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ZoteroPaperPane } from '../../../src/renderer/src/components/preview/ZoteroPaperPane';

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getParsedMarkdown: vi.fn().mockResolvedValue(null),
      getFullText: vi.fn().mockResolvedValue({ quality: 'poor' }),
      onMinerUProgress: vi.fn(() => vi.fn()),
      getSettings: vi.fn().mockResolvedValue({ hasMinerUApiKey: true }),
      parseWithMinerU: vi.fn(),
      setMinerUApiKey: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useZoteroPdf: () => new Uint8Array([1, 2, 3]),
  useZoteroPaperItemKey: () => 'item-1',
}));

vi.mock('../../../src/renderer/src/components/preview/PdfPreviewPane', () => ({
  PdfPreviewPane: () => <div data-testid="pdf-preview" />,
}));

vi.mock('../../../src/renderer/src/components/preview/ZoteroParsedMarkdownView', () => ({
  ZoteroParsedMarkdownView: () => <div data-testid="parsed-md" />,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroPaper.empty': 'Ctrl+Click a citation to view its PDF',
        'zoteroPaper.parseButton': 'Precise parse',
        'zoteroPaper.viewPdf': 'Raw PDF',
        'zoteroPaper.viewMarkdown': 'Parsed MD',
        'zoteroPaper.mdUnavailable': 'Not parsed yet',
        'zoteroPaper.qualityPoor': 'Local extraction looks poor',
        'zoteroMineru.dialog.title': 'Configure MinerU',
        'zoteroMineru.dialog.cancel': 'Cancel',
        'zoteroMineru.dialog.save': 'Save',
        'zoteroMineru.dialog.tokenLabel': 'Token',
        'zoteroMineru.dialog.tokenPlaceholder': 'Paste token',
        'zoteroMineru.dialog.privacyTitle': 'Privacy',
        'zoteroMineru.dialog.privacyBody': 'Uploads PDF',
        'zoteroMineru.dialog.consent': 'I agree',
        'zoteroMineru.dialog.showToken': 'Show token',
        'zoteroMineru.dialog.hideToken': 'Hide token',
        'common.close': 'Close',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('ZoteroPaperPane', () => {
  it('exposes PDF/markdown modes and parse actions as focusable controls', async () => {
    render(<ZoteroPaperPane />);

    await screen.findByText('Local extraction looks poor');

    const pdf = screen.getByRole('button', { name: 'Raw PDF' });
    expect(pdf).toHaveAttribute('aria-pressed', 'true');
    expect(pdf).toHaveClass('focus-visible:ring-2');

    const markdown = screen.getByRole('button', { name: 'Parsed MD' });
    expect(markdown).toHaveAttribute('aria-pressed', 'false');
    expect(markdown).toBeDisabled();

    const parseButtons = screen.getAllByRole('button', { name: 'Precise parse' });
    for (const button of parseButtons) {
      expect(button).toHaveClass('cursor-pointer');
      expect(button).toHaveClass('focus-visible:ring-2');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
