import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompileLogPanel } from '../../../src/renderer/src/components/preview/CompileLogPanel';
import type { ParsedLogEntry } from '../../../src/renderer/src/types';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data: ParsedLogEntry[]; itemContent: Function }) => (
    <div>{data.map((entry, index) => itemContent(index, entry))}</div>
  ),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'compileLog.log': 'Log',
        'compileLog.all': 'All',
        'compileLog.errors': 'Errors',
        'compileLog.warnings': 'Warnings',
        'compileLog.info': 'Info',
        'compileLog.noLogs': 'No',
        'compileLog.noErrors': 'errors',
        'compileLog.noWarnings': 'warnings',
        'compileLog.noInfo': 'info',
        'compileLog.logs': 'logs',
        'compileLog.unknownLog': 'Unknown log',
        'common.close': 'Close',
      };
      return values[key] ?? key;
    },
  }),
}));

const errorEntry: ParsedLogEntry = {
  level: 'error',
  file: './main.tex',
  line: 12,
  message: 'Undefined control sequence',
  content: 'l.12 \\badcommand',
};

const warningEntry: ParsedLogEntry = {
  level: 'warning',
  file: './main.tex',
  line: 20,
  message: 'Overfull hbox',
};

describe('CompileLogPanel', () => {
  it('renders log filters as accessible toggle buttons with focus feedback', () => {
    render(<CompileLogPanel errors={[errorEntry]} warnings={[warningEntry]} />);

    const all = screen.getByRole('button', { name: /All/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveClass('cursor-pointer');
    expect(all).toHaveClass('focus-visible:ring-1');

    const errors = screen.getByRole('button', { name: /Errors/ });
    expect(errors).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(errors);
    expect(errors).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Overfull hbox')).not.toBeInTheDocument();
  });

  it('labels close, expand, and source-jump actions for keyboard users', () => {
    const onClose = vi.fn();
    const onJumpToLine = vi.fn();
    render(
      <CompileLogPanel
        errors={[errorEntry]}
        onClose={onClose}
        onJumpToLine={onJumpToLine}
      />
    );

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close).toHaveClass('focus-visible:ring-1');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();

    const expand = screen.getByRole('button', { name: 'Expand log details' });
    expect(expand).toHaveClass('cursor-pointer');
    expect(expand).toHaveClass('focus-visible:ring-1');
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse log details' })).toBeInTheDocument();

    const jump = screen.getByRole('button', { name: 'Open main.tex line 12' });
    expect(jump).toHaveClass('cursor-pointer');
    expect(jump).toHaveClass('focus-visible:ring-1');
    fireEvent.click(jump);
    expect(onJumpToLine).toHaveBeenCalledWith('main.tex', 12);
  });
});
