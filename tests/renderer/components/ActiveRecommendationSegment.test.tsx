import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRecommendationSegment } from '../../../src/renderer/src/components/layout/ActiveRecommendationSegment';
import type { RecommendationState } from '../../../src/renderer/src/services/zotero/ActiveRecommendationService';

const mockRecommendation = vi.hoisted(() => {
  const createReadyState = (): RecommendationState => ({
    indexState: 'ready',
    loading: false,
    items: [
      {
        itemKey: 'ITEM1',
        citationKey: 'smith2024',
        title: 'Neural Methods for Scientific Writing',
        score: 0.91,
        reason: 'Matches the current paragraph',
        reranked: true,
      },
    ],
  });

  return {
    createReadyState,
    insertCitation: vi.fn(),
    state: createReadyState(),
  };
});

vi.mock('../../../src/renderer/src/hooks', () => ({
  useClickOutside: () => undefined,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'zoteroRecommend.title': 'Might cite',
        'zoteroRecommend.insertHint': 'Click to insert citation at the cursor',
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/renderer/src/services/zotero/ActiveRecommendationService', () => ({
  getActiveRecommendationService: () => ({
    subscribe: () => () => undefined,
    getState: () => mockRecommendation.state,
    insertCitation: mockRecommendation.insertCitation,
  }),
}));

describe('ActiveRecommendationSegment', () => {
  beforeEach(() => {
    mockRecommendation.insertCitation.mockClear();
    mockRecommendation.state = mockRecommendation.createReadyState();
  });

  it('exposes the recommendation badge as an expandable status control', () => {
    render(<ActiveRecommendationSegment />);

    const trigger = screen.getByRole('button', { name: 'Might cite' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveClass('focus-visible:ring-1');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const popover = screen.getByRole('dialog', { name: 'Might cite' });
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
  });

  it('renders recommendation rows as focusable pointer actions', () => {
    render(<ActiveRecommendationSegment />);

    fireEvent.click(screen.getByRole('button', { name: 'Might cite' }));

    const item = screen.getByRole('button', { name: /Neural Methods for Scientific Writing/ });
    expect(item).toHaveClass('cursor-pointer');
    expect(item).toHaveClass('focus-visible:ring-1');

    fireEvent.click(item);
    expect(mockRecommendation.insertCitation).toHaveBeenCalledWith('smith2024');
  });

  it('moves focus into the popover and restores it when Escape closes', () => {
    render(<ActiveRecommendationSegment />);

    const trigger = screen.getByRole('button', { name: 'Might cite' });
    trigger.focus();
    fireEvent.click(trigger);

    const item = screen.getByRole('button', { name: /Neural Methods for Scientific Writing/ });
    expect(item).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Might cite' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Might cite' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps tab focus cycling inside recommendation actions', () => {
    mockRecommendation.state = {
      ...mockRecommendation.state,
      items: [
        mockRecommendation.state.items[0],
        {
          itemKey: 'ITEM2',
          citationKey: 'lee2025',
          title: 'Citation Grounding at the Cursor',
          score: 0.82,
          reason: 'Complements the selected sentence',
          reranked: true,
        },
      ],
    };

    render(<ActiveRecommendationSegment />);

    fireEvent.click(screen.getByRole('button', { name: 'Might cite' }));

    const dialog = screen.getByRole('dialog', { name: 'Might cite' });
    const firstItem = screen.getByRole('button', { name: /Neural Methods for Scientific Writing/ });
    const secondItem = screen.getByRole('button', { name: /Citation Grounding at the Cursor/ });

    expect(firstItem).toHaveFocus();

    secondItem.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(firstItem).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(secondItem).toHaveFocus();
  });
});
