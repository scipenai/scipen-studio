import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileNode } from '../../../src/renderer/src/types';
import { Toolbar } from '../../../src/renderer/src/components/file-explorer/FileExplorerToolbar';

const directoryNode: FileNode = {
  name: 'sections',
  path: 'D:/paper/sections',
  type: 'directory',
  children: [],
};

describe('FileExplorer Toolbar', () => {
  it('labels icon-only actions and creates items in the selected directory', () => {
    const onNewFile = vi.fn();
    const onNewFolder = vi.fn();
    const onRefresh = vi.fn();

    render(
      <Toolbar
        projectPath="D:/paper"
        selectedNode={directoryNode}
        isRefreshing={false}
        onRefresh={onRefresh}
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onNewFile).toHaveBeenCalledWith('D:/paper/sections');
    expect(onNewFolder).toHaveBeenCalledWith('D:/paper/sections');
    expect(onRefresh).toHaveBeenCalledWith('manual');
  });

  it('uses unavailable cursor feedback while refresh is running', () => {
    render(
      <Toolbar
        projectPath="D:/paper"
        selectedNode={null}
        isRefreshing={true}
        onRefresh={vi.fn()}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass('cursor-wait');
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveClass('cursor-pointer');
  });
});
