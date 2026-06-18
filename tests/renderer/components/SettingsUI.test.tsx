import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EditableShortcut,
  FormField,
  SettingItem,
} from '../../../src/renderer/src/components/settings/SettingsUI';

describe('EditableShortcut', () => {
  it('announces shortcut recording state and keeps the action focusable', () => {
    const onChange = vi.fn();
    render(<EditableShortcut label="Compile" keys="Ctrl+Enter" onChange={onChange} />);

    const shortcut = screen.getByRole('button', { name: 'Compile Ctrl+Enter' });
    expect(shortcut).toHaveAttribute('aria-pressed', 'false');
    expect(shortcut).toHaveClass('cursor-pointer');
    expect(shortcut).toHaveClass('focus-visible:ring-2');

    fireEvent.click(shortcut);
    expect(shortcut).toHaveAttribute('aria-pressed', 'true');
    expect(shortcut).toHaveAccessibleName('Compile Press shortcut...');

    fireEvent.keyDown(shortcut, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('Ctrl+Shift+K');
    expect(shortcut).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Settings field containers', () => {
  it('connects SettingItem labels and descriptions to direct native controls', () => {
    render(
      <SettingItem label="Compiler engine" description="Choose the LaTeX backend">
        <select defaultValue="xelatex">
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
      </SettingItem>
    );

    const select = screen.getByRole('combobox', { name: 'Compiler engine' });
    expect(select).toHaveAccessibleDescription('Choose the LaTeX backend');
  });

  it('connects FormField labels and descriptions to direct native controls', () => {
    render(
      <FormField title="API Key" description="Used to call the configured provider">
        <input type="password" defaultValue="sk-test" />
      </FormField>
    );

    const input = screen.getByLabelText('API Key');
    expect(input).toHaveAccessibleDescription('Used to call the configured provider');
  });

  it('connects FormField labels to the first native control when helper actions follow', () => {
    render(
      <FormField title="Base URL" description="Provider endpoint">
        <input defaultValue="https://api.example.com" />
        <button type="button">Test</button>
      </FormField>
    );

    const input = screen.getByRole('textbox', { name: 'Base URL' });
    expect(input).toHaveAccessibleDescription('Provider endpoint');
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
  });
});
