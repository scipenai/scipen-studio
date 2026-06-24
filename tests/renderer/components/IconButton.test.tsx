import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconButton } from '../../../src/renderer/src/components/ui/IconButton';

describe('IconButton', () => {
  it('uses tooltip text as the accessible name for icon-only buttons', () => {
    render(
      <IconButton tooltip="Toggle preview">
        <svg aria-hidden="true" />
      </IconButton>
    );

    expect(screen.getByRole('button', { name: 'Toggle preview' })).toBeInTheDocument();
  });

  it('shows pointer affordance when enabled and disabled affordance when unavailable', () => {
    const { rerender } = render(
      <IconButton tooltip="Open files">
        <svg aria-hidden="true" />
      </IconButton>
    );

    expect(screen.getByRole('button', { name: 'Open files' })).toHaveClass('cursor-pointer');

    rerender(
      <IconButton tooltip="Open files" disabled={true}>
        <svg aria-hidden="true" />
      </IconButton>
    );

    expect(screen.getByRole('button', { name: 'Open files' })).toHaveClass(
      'disabled:cursor-not-allowed'
    );
    expect(screen.getByRole('button', { name: 'Open files' })).not.toHaveClass(
      'disabled:pointer-events-none'
    );
  });
});
