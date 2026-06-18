import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectCitedReferencesPanel } from '../../../src/renderer/src/components/zotero/ProjectCitedReferencesPanel';

const firePreviewToEditor = vi.fn();

vi.mock('../../../src/renderer/src/services/core', () => ({
  getEditorService: () => ({
    onDidChangeContent: vi.fn(() => ({ dispose: vi.fn() })),
  }),
  getUIService: () => ({
    firePreviewToEditor,
  }),
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useActiveTab: () => ({
    path: 'D:/paper/main.tex',
    content: 'See \\cite{smith2024} for details.',
  }),
}));

vi.mock('../../../src/renderer/src/services/zotero/ZoteroBibMirror', () => ({
  getZoteroBibMirror: () => ({
    getState: () => ({ ready: true, itemCount: 1, etag: 1 }),
    subscribe: vi.fn(() => vi.fn()),
    getByCitationKey: (key: string) =>
      key === 'smith2024' ? { citationKey: 'smith2024', title: 'Readable Citations' } : undefined,
    getByItemKey: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'projectCitedReferences.title': 'Cited in this paper',
        'projectCitedReferences.emptyNoCites': 'No citations',
        'projectCitedReferences.emptyNoIndex': 'Connect Zotero',
        'projectCitedReferences.firstOf': `Cited ${params?.n ?? 0} times`,
      };
      return values[key] ?? key;
    },
  }),
}));

describe('ProjectCitedReferencesPanel', () => {
  it('announces expansion state and keeps cited references keyboard reachable', () => {
    render(<ProjectCitedReferencesPanel />);

    const header = screen.getByRole('button', { name: /Cited in this paper/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveClass('focus-visible:ring-2');
    expect(header.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');

    const entry = screen.getByRole('button', { name: /smith2024/ });
    expect(entry).toHaveClass('cursor-pointer');
    expect(entry).toHaveClass('focus-visible:ring-2');
    fireEvent.click(entry);
    expect(firePreviewToEditor).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'D:/paper/main.tex' })
    );
  });
});
