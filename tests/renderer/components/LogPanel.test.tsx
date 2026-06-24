import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LogPanel } from '../../../src/renderer/src/components/LogPanel';

const clearCompilationLogs = vi.fn();

const logs = [
  {
    id: 'log-1',
    type: 'error' as const,
    message: 'Undefined control sequence',
    timestamp: 1_700_000_000_000,
    details: 'l.12 \\badcommand',
  },
];

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data: typeof logs; itemContent: Function }) => (
    <div>{data.map((entry, index) => itemContent(index, entry))}</div>
  ),
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getUIService: () => ({ clearCompilationLogs }),
  useCompilationLogs: () => logs,
  useCompilationResult: () => ({ success: false, time: 1200 }),
  useIsCompiling: () => false,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'logPanel.title': 'Logs',
        'logPanel.failed': 'Failed',
        'logPanel.clearLog': 'Clear log',
        'logPanel.collapse': 'Collapse',
        'logPanel.expand': 'Expand',
        'logPanel.details': 'Details',
        'logPanel.copy': 'Copy',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('LogPanel', () => {
  it('labels log controls and exposes detailed log rows as keyboard actions', () => {
    render(<LogPanel />);

    const clear = screen.getByRole('button', { name: 'Clear log' });
    expect(clear).toHaveClass('cursor-pointer');
    expect(clear).toHaveClass('focus-visible:ring-1');
    fireEvent.click(clear);
    expect(clearCompilationLogs).toHaveBeenCalled();

    const collapse = screen.getByRole('button', { name: 'Collapse' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse).toHaveClass('cursor-pointer');

    const row = screen.getByRole('button', { name: /Undefined control sequence/ });
    expect(row).toHaveClass('cursor-pointer');
    expect(row).toHaveClass('focus-visible:ring-1');
    fireEvent.click(row);

    expect(screen.getByText('l.12 \\badcommand')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Close details' })).toHaveClass('cursor-pointer');
  });
});
