import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../../../src/renderer/src/components/ui/CopyButton';

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'chat.copyMessage': 'Copy message',
        'chat.copied': 'Copied',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('CopyButton', () => {
  it('renders a named copy action with pointer and keyboard focus affordances', () => {
    render(<CopyButton text="hello" />);

    const button = screen.getByRole('button', { name: 'Copy message' });
    expect(button).toHaveClass('cursor-pointer');
    expect(button).toHaveClass('focus-visible:ring-2');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
