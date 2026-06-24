import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VirtualizedFileTree } from '../../../src/renderer/src/components/VirtualizedFileTree';
import type { FileNode } from '../../../src/renderer/src/types';

vi.mock('react-virtuoso', () => ({
  Virtuoso: <T,>({
    data,
    itemContent,
    className,
    style,
  }: {
    data: T[];
    itemContent: (index: number, item: T) => React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <div className={className} style={style}>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'fileTree.noFiles': 'No files',
      };
      return values[key] ?? key;
    },
  }),
}));

const tree: FileNode = {
  name: 'paper',
  path: 'D:/paper',
  type: 'directory',
  children: [
    {
      name: 'src',
      path: 'D:/paper/src',
      type: 'directory',
      children: [{ name: 'main.tex', path: 'D:/paper/src/main.tex', type: 'file' }],
    },
  ],
};

describe('VirtualizedFileTree', () => {
  it('renders tree rows as keyboard reachable treeitems with expansion state', () => {
    const onSelect = vi.fn();

    render(
      <VirtualizedFileTree
        fileTree={tree}
        selectedPath={null}
        activeTabPath={null}
        onSelect={onSelect}
        onContextMenu={vi.fn()}
        renamingPath={null}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
      />
    );

    const directory = screen.getByRole('treeitem', { name: 'src' });
    expect(directory).toHaveAttribute('aria-expanded', 'false');
    expect(directory).toHaveClass('focus-visible:ring-2');
    expect(directory.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.keyDown(directory, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'D:/paper/src' }));
    expect(directory).toHaveAttribute('aria-expanded', 'true');

    const file = screen.getByRole('treeitem', { name: 'main.tex' });
    expect(file).toHaveClass('cursor-pointer');
    fireEvent.keyDown(file, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'D:/paper/src/main.tex' })
    );
  });

  it('opens the row context menu from keyboard shortcuts', () => {
    const onContextMenu = vi.fn();

    render(
      <VirtualizedFileTree
        fileTree={tree}
        selectedPath={null}
        activeTabPath={null}
        onSelect={vi.fn()}
        onContextMenu={onContextMenu}
        renamingPath={null}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
      />
    );

    const directory = screen.getByRole('treeitem', { name: 'src' });
    fireEvent.keyDown(directory, { key: 'ContextMenu' });

    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyboard' }),
      expect.objectContaining({ path: 'D:/paper/src' })
    );

    fireEvent.keyDown(directory, { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });
});
