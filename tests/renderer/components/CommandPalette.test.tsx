import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../../../src/renderer/src/components/CommandPalette';

let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

const uiService = vi.hoisted(() => ({
  requestChatWithText: vi.fn(),
  setRightPanelTab: vi.fn(),
  setSidebarTab: vi.fn(),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/hooks', () => ({
  useWindowEvent: (_type: string, handler: (event: KeyboardEvent) => void) => {
    keydownHandler = handler;
  },
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getUIService: () => uiService,
}));

vi.mock('../../../src/renderer/src/services/core/HistoryUIBus', () => ({
  historyUIBus: {
    openCreateLabel: vi.fn(),
    openBrowseLabels: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'commandPalette.openAI': 'Open AI Assistant',
        'commandPalette.openAIDesc': 'Chat with AI assistant for help',
        'commandPalette.saveFile': 'Save File',
        'commandPalette.compileDoc': 'Compile Document',
        'commandPalette.compileDocDesc': 'Compile current document',
        'commandPalette.showPdfPreview': 'Show PDF Preview',
        'commandPalette.openSettings': 'Open Settings',
        'commandPalette.showShortcuts': 'Show Shortcuts',
        'commandPalette.placeholder': 'Type command or search...',
        'commandPalette.noResults': 'No matching commands found',
        'commandPalette.navigate': 'Navigate',
        'commandPalette.execute': 'Execute',
        'commandPalette.openPalette': 'Ctrl+P to open command palette',
        'history.createLabel': 'Create snapshot label',
        'history.createLabelDesc': 'Capture a snapshot',
        'history.browserTitle': 'History',
        'history.browseLabelsDesc': 'Browse labels',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    keydownHandler = undefined;
  });

  it('renders as a searchable command dialog with selectable command options', () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Command Palette' });
    expect(dialog).toBeInTheDocument();

    const input = screen.getByRole('combobox', { name: 'Command search' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'command-palette-listbox');
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-ai-chat');

    const listbox = screen.getByRole('listbox', { name: 'Commands' });
    expect(listbox).toHaveAttribute('id', 'command-palette-listbox');

    const first = screen.getByRole('option', { name: /Open AI Assistant/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveClass('cursor-pointer');
    expect(first).toHaveClass('focus-visible:ring-2');

    expect(screen.getByText('Arrow keys')).toBeInTheDocument();
    expect(screen.getByText('Enter')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'settings' } });
    expect(screen.getByRole('option', { name: /Open Settings/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    fireEvent.change(input, { target: { value: 'zzzzzz' } });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('No matching commands found')).toBeInTheDocument();
  });

  it('focuses search on open and restores focus to the opener on close', () => {
    const CommandPaletteHarness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open command palette
          </button>
          <CommandPalette isOpen={open} onClose={() => setOpen(false)} />
        </>
      );
    };

    render(<CommandPaletteHarness />);

    const opener = screen.getByRole('button', { name: 'Open command palette' });
    opener.focus();
    fireEvent.click(opener);

    const search = screen.getByRole('combobox', { name: 'Command search' });
    expect(search).toHaveFocus();

    act(() => {
      keydownHandler?.(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('wraps keyboard selection between the first and last command', () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);

    const input = screen.getByRole('combobox', { name: 'Command search' });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-ai-chat');

    act(() => {
      keydownHandler?.(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-help-shortcuts');

    act(() => {
      keydownHandler?.(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-ai-chat');
  });
});
