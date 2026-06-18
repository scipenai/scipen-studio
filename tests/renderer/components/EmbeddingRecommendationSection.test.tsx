import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingRecommendationSection } from '../../../src/renderer/src/components/settings/EmbeddingRecommendationSection';

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    zotero: {
      getSettings: vi.fn().mockResolvedValue({
        activeRecommendation: true,
        hasEmbeddingApiKey: true,
      }),
      getEmbeddingStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        embedded: 4,
        total: 4,
      }),
      onSettingsChanged: vi.fn(() => vi.fn()),
      onEmbeddingProgress: vi.fn(() => vi.fn()),
      setSettings: vi.fn(),
      rebuildEmbeddingIndex: vi.fn(),
      setEmbeddingApiKey: vi.fn().mockResolvedValue({ success: true }),
    },
  },
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
        'zoteroEmbedding.sectionTitle': 'Active citation recommendations',
        'zoteroEmbedding.toggleLabel': 'Suggest references while writing',
        'zoteroEmbedding.toggleDesc': 'Recommend papers',
        'zoteroEmbedding.statusLabel': 'Index status',
        'zoteroEmbedding.state.disabled': 'Disabled',
        'zoteroEmbedding.state.ready': 'Ready',
        'zoteroEmbedding.configureKey': 'Configure Embedding Key',
        'zoteroEmbedding.rebuild': 'Rebuild index',
        'zoteroEmbedding.dialog.title': 'Set up recommendations',
        'zoteroEmbedding.dialog.cancel': 'Cancel',
        'zoteroEmbedding.dialog.save': 'Save',
        'zoteroEmbedding.dialog.privacyTitle': 'Privacy',
        'zoteroEmbedding.dialog.privacyBody': 'Sends text',
        'zoteroEmbedding.dialog.providerLabel': 'Embedding provider',
        'zoteroEmbedding.dialog.keyLabel': 'API Key',
        'zoteroEmbedding.dialog.keyPlaceholder': 'Paste key',
        'zoteroEmbedding.dialog.consent': 'I agree',
        'zoteroEmbedding.dialog.showKey': 'Show key',
        'zoteroEmbedding.dialog.hideKey': 'Hide key',
        'zoteroEmbedding.provider.zhipu': 'Zhipu',
        'zoteroEmbedding.provider.aliyun': 'Aliyun',
        'zoteroEmbedding.provider.openai': 'OpenAI',
        'common.close': 'Close',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('EmbeddingRecommendationSection', () => {
  it('renders recommendation settings actions with pointer and focus affordances', async () => {
    render(<EmbeddingRecommendationSection />);

    expect(await screen.findByText('Ready')).toBeInTheDocument();

    for (const label of ['Configure Embedding Key', 'Rebuild index']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toHaveClass('cursor-pointer');
      expect(action).toHaveClass('focus-visible:ring-2');
      expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
