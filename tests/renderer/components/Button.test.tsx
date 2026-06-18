import { render, screen } from '@testing-library/react';
import { Loader2 } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Button } from '../../../src/renderer/src/components/ui/Button';

describe('Button', () => {
  it('keeps disabled and loading states visually discoverable while hiding decorative icons', () => {
    render(
      <>
        <Button disabled leftIcon={<Loader2 data-testid="left-icon" />}>
          Save
        </Button>
        <Button loading>Loading</Button>
      </>
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveClass('disabled:cursor-not-allowed');
    expect(screen.getByTestId('left-icon')).toHaveAttribute('aria-hidden', 'true');

    const loading = screen.getByRole('button', { name: 'Loading' });
    expect(loading).toBeDisabled();
    expect(loading).toHaveClass('cursor-wait');
    expect(loading.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
