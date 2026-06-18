import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../../../src/renderer/src/components/ui/Select';

const options = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'disabled', label: 'Disabled', disabled: true },
];

describe('Select', () => {
  it('exposes dropdown state and option selection semantics', () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Provider"
        value="openai"
        options={options}
        onChange={onChange}
        fullWidth={false}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Provider: OpenAI' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveClass('cursor-pointer');
    expect(trigger).toHaveClass('focus-visible:ring-2');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'Provider' });
    expect(trigger).toHaveAttribute('aria-controls', listbox.id);

    expect(screen.getByRole('option', { name: 'OpenAI' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('option', { name: 'Anthropic' })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }));
    expect(onChange).toHaveBeenCalledWith('anthropic');
  });
});
