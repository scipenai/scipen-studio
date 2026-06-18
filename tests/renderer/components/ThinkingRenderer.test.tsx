import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThinkingRenderer } from '../../../src/renderer/src/components/chat/ThinkingRenderer';

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'chat.thinking.streaming': 'Thinking',
        'chat.thinking.completed': 'Thought process',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('ThinkingRenderer', () => {
  it('announces expanded state and hides decorative indicators', () => {
    render(<ThinkingRenderer text="reasoning text" />);

    const toggle = screen.getByRole('button', { name: /Thought process/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('cursor-pointer');
    expect(toggle).toHaveClass('focus-visible:ring-2');
    expect(toggle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('reasoning text')).toBeInTheDocument();
  });
});
