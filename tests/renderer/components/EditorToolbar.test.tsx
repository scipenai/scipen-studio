import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorToolbar } from '../../../src/renderer/src/components/editor/components/EditorToolbar';
import type { EditorTab } from '../../../src/renderer/src/types';

vi.mock('../../../src/renderer/src/locales', () => ({
  t: (key: string, params?: Record<string, string>) => {
    const values: Record<string, string> = {
      'diffReview.pendingReview': 'Pending AI Review',
      'diffReview.changesCount': `${params?.count ?? '0'} changes`,
      'diffReview.nextChange': 'Next change',
      'diffReview.acceptAll': 'Accept All',
      'diffReview.rejectAll': 'Reject All',
      'editorToolbar.jumpToPdf': 'Jump to PDF',
      'editorToolbar.stopCompile': 'Stop compile',
      'editorToolbar.compile': 'Compile',
      'editorToolbar.stop': 'Stop',
      'editor.compile': 'Compile',
      'common.close': 'Close',
    };
    return values[key] ?? key;
  },
}));

const tabs: EditorTab[] = [
  {
    _id: 'main',
    path: 'D:/paper/main.tex',
    name: 'main.tex',
    content: '',
    language: 'latex',
    isDirty: false,
  },
];

function renderToolbar(overrides: Partial<React.ComponentProps<typeof EditorToolbar>> = {}) {
  return render(
    <EditorToolbar
      openTabs={tabs}
      activeTabPath="D:/paper/main.tex"
      isCompiling={false}
      hasPdf
      onTabClick={vi.fn()}
      onTabClose={vi.fn()}
      onSyncTexJump={vi.fn()}
      onCompile={vi.fn()}
      {...overrides}
    />
  );
}

describe('EditorToolbar', () => {
  it('renders tabs and tab close controls as keyboard-focusable actions', () => {
    const onTabClick = vi.fn();
    const onTabClose = vi.fn();
    renderToolbar({ onTabClick, onTabClose });

    const tab = screen.getByRole('tab', { name: 'main.tex' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveClass('cursor-pointer');
    expect(tab).toHaveClass('focus-visible:ring-1');

    fireEvent.click(tab);
    expect(onTabClick).toHaveBeenCalledWith('D:/paper/main.tex');

    const close = screen.getByRole('button', { name: 'Close main.tex' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-1');

    fireEvent.click(close);
    expect(onTabClose).toHaveBeenCalled();
  });

  it('labels compile and SyncTeX controls with visible focus and unavailable cursor states', () => {
    renderToolbar({ hasPdf: false, openTabs: [] });

    const jump = screen.getByRole('button', { name: 'Jump to PDF' });
    expect(jump).toBeDisabled();
    expect(jump).toHaveClass('cursor-not-allowed');
    expect(jump).toHaveClass('focus-visible:ring-1');

    const compile = screen.getByRole('button', { name: 'Compile' });
    expect(compile).toBeDisabled();
    expect(compile).toHaveClass('cursor-not-allowed');
    expect(compile).toHaveClass('focus-visible:ring-1');
  });
});
