import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../../../src/renderer/src/components/ui/Input';

describe('Input', () => {
  it('connects labels and exposes password visibility as a keyboard action', () => {
    render(<Input label="API key" type="password" />);

    const input = screen.getByLabelText('API key');
    expect(input).toHaveAttribute('type', 'password');

    const reveal = screen.getByRole('button', { name: 'Show password' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    expect(reveal).toHaveClass('cursor-pointer');
    expect(reveal).toHaveClass('focus-visible:ring-2');
    expect(reveal).not.toHaveAttribute('tabindex', '-1');
    expect(reveal.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(reveal);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(input).toHaveAttribute('type', 'text');
  });
});
