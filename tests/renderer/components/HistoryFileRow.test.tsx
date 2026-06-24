import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HistoryFileRow,
  type HistoryFileSnapshot,
} from '../../../src/renderer/src/components/history/HistoryFileRow';

const t = (key: string) => {
  const values: Record<string, string> = {
    'history.viewDiff': 'View diff',
    'history.diffStatsClosed': 'Closed',
    'history.diffStatsNoChange': 'No changes',
  };
  return values[key] ?? key;
};

describe('HistoryFileRow', () => {
  it('keeps the diff action keyboard reachable while hiding the decorative icon', () => {
    const file: HistoryFileSnapshot = {
      fileId: 'src/main.tex',
      beforeText: 'before',
      afterText: 'after',
      stats: { added: 2, removed: 1 },
    };
    const onViewDiff = vi.fn();

    render(<HistoryFileRow file={file} onViewDiff={onViewDiff} t={t as never} />);

    const action = screen.getByRole('button', { name: 'View diff' });
    expect(action).toHaveAttribute('type', 'button');
    expect(action).toHaveClass('cursor-pointer');
    expect(action).toHaveClass('focus-visible:ring-2');
    expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(action);
    expect(onViewDiff).toHaveBeenCalledWith(file);
  });
});
