import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../../../src/renderer/src/components/file-explorer/ContextMenu';

const clipboardMocks = vi.hoisted(() => ({
  getClipboardItem: vi.fn(),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'fileExplorerMenu.actions': 'File actions',
        'fileExplorerMenu.newFile': 'New File',
        'fileExplorerMenu.newFolder': 'New Folder',
        'fileExplorerMenu.rename': 'Rename',
        'fileExplorerMenu.copy': 'Copy',
        'fileExplorerMenu.cut': 'Cut',
        'fileExplorerMenu.paste': 'Paste',
        'fileExplorerMenu.delete': 'Delete',
        'fileExplorerMenu.openInExplorer': 'Open in Explorer',
        'fileExplorerMenu.refresh': 'Refresh',
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/renderer/src/hooks', () => ({
  useClickOutside: vi.fn(),
  useEscapeKey: vi.fn(),
}));

vi.mock('../../../src/renderer/src/components/file-explorer/clipboard', () => ({
  getClipboardItem: clipboardMocks.getClipboardItem,
}));

const baseProps = {
  x: 20,
  y: 30,
  node: {
    name: 'main.tex',
    path: 'D:/paper/main.tex',
    type: 'file' as const,
  },
  isRoot: false,
  isRemote: false,
  onClose: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onCopy: vi.fn(),
  onCut: vi.fn(),
  onPaste: vi.fn(),
  onOpenInExplorer: vi.fn(),
  onRefresh: vi.fn(),
};

describe('ContextMenu', () => {
  it('renders file actions as an accessible menu with disabled-state feedback', () => {
    clipboardMocks.getClipboardItem.mockReturnValue(null);
    const onClose = vi.fn();
    const onCopy = vi.fn();

    render(<ContextMenu {...baseProps} onClose={onClose} onCopy={onCopy} />);

    expect(screen.getByRole('menu', { name: 'File actions' })).toBeInTheDocument();

    const copy = screen.getByRole('menuitem', { name: 'Copy' });
    expect(copy).toHaveClass('cursor-pointer');
    expect(copy).toHaveClass('focus-visible:ring-2');
    expect(copy.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const paste = screen.getByRole('menuitem', { name: 'Paste' });
    expect(paste).toBeDisabled();
    expect(paste).toHaveAttribute('aria-disabled', 'true');
    expect(paste).toHaveClass('disabled:cursor-not-allowed');
  });

  it('focuses the first enabled action and supports arrow-key execution', () => {
    clipboardMocks.getClipboardItem.mockReturnValue(null);
    const onClose = vi.fn();
    const onNewFolder = vi.fn();

    render(<ContextMenu {...baseProps} onClose={onClose} onNewFolder={onNewFolder} />);

    const newFile = screen.getByRole('menuitem', { name: 'New File' });
    const newFolder = screen.getByRole('menuitem', { name: 'New Folder' });
    const paste = screen.getByRole('menuitem', { name: 'Paste' });

    expect(newFile).toHaveFocus();

    fireEvent.keyDown(newFile, { key: 'ArrowDown' });
    expect(newFolder).toHaveFocus();

    fireEvent.keyDown(newFolder, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Copy' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Cut' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Cut' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Cut' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Cut' }), { key: 'Home' });
    expect(newFile).toHaveFocus();

    fireEvent.keyDown(newFile, { key: 'ArrowDown' });
    expect(newFolder).toHaveFocus();

    fireEvent.keyDown(newFolder, { key: 'Enter' });
    expect(onNewFolder).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the focused menu item with Escape', () => {
    clipboardMocks.getClipboardItem.mockReturnValue(null);
    const onClose = vi.fn();

    render(<ContextMenu {...baseProps} onClose={onClose} />);

    const newFile = screen.getByRole('menuitem', { name: 'New File' });
    expect(newFile).toHaveFocus();

    fireEvent.keyDown(newFile, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the invoking control after closing', () => {
    clipboardMocks.getClipboardItem.mockReturnValue(null);

    const MenuHarness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open file actions
          </button>
          {open && <ContextMenu {...baseProps} onClose={() => setOpen(false)} />}
        </>
      );
    };

    render(<MenuHarness />);

    const opener = screen.getByRole('button', { name: 'Open file actions' });
    opener.focus();
    fireEvent.click(opener);

    const newFile = screen.getByRole('menuitem', { name: 'New File' });
    expect(newFile).toHaveFocus();

    fireEvent.keyDown(newFile, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'File actions' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
