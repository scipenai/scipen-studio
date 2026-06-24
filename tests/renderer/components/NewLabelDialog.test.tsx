import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewLabelDialog } from '../../../src/renderer/src/components/history/NewLabelDialog';

const openCreateLabelHandlers = vi.hoisted(() => new Set<() => void>());
const focusTrapMock = vi.hoisted(() => vi.fn());

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/hooks/useFocusTrap', () => ({
  useFocusTrap: focusTrapMock,
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    history: {
      putBlob: vi.fn(),
      createLabel: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getEditorService: () => ({ tabs: [] }),
  getProjectRuntimeContext: () => ({ rootPath: 'D:/paper' }),
}));

vi.mock('../../../src/renderer/src/services/core/HistoryUIBus', () => ({
  historyUIBus: {
    onOpenCreateLabel: (handler: () => void) => {
      openCreateLabelHandlers.add(handler);
      return { dispose: () => openCreateLabelHandlers.delete(handler) };
    },
    fireLabelsChanged: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/utils/historyProjectId', () => ({
  historyProjectIdOf: () => 'project-1',
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'history.createLabel': 'Create snapshot label',
        'history.close': 'Close',
        'history.createLabelDesc': 'Capture every open file.',
        'history.labelNamePlaceholder': 'Label name',
        'history.labelDescriptionPlaceholder': 'Description',
        'history.cancel': 'Cancel',
        'history.submit': 'Create',
        'history.labelCreating': 'Creating',
        'history.labelNoFiles': 'No files',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('NewLabelDialog', () => {
  it('returns focus to the opener when Escape closes the dialog', async () => {
    render(
      <>
        <button type="button">Open label dialog</button>
        <NewLabelDialog />
      </>
    );

    const opener = screen.getByRole('button', { name: 'Open label dialog' });
    opener.focus();

    await act(async () => {
      for (const handler of openCreateLabelHandlers) handler();
    });

    const dialog = screen.getByRole('dialog', { name: 'Create snapshot label' });
    expect(screen.getByLabelText('Label name')).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Create snapshot label' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('opens as a labelled form dialog with readable shortcut hints and button states', async () => {
    focusTrapMock.mockClear();
    render(<NewLabelDialog />);

    await act(async () => {
      for (const handler of openCreateLabelHandlers) handler();
    });

    expect(screen.getByRole('dialog', { name: 'Create snapshot label' })).toBeInTheDocument();
    expect(screen.getByLabelText('Label name')).toHaveClass('focus-visible:ring-1');
    expect(screen.getByLabelText('Description')).toHaveClass('focus-visible:ring-1');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('cursor-pointer');
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    expect(screen.getByText('Ctrl+Enter / Esc')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Create' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveClass('disabled:cursor-not-allowed');

    fireEvent.change(screen.getByLabelText('Label name'), {
      target: { value: 'Draft checkpoint' },
    });
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    expect(focusTrapMock).toHaveBeenCalledWith(expect.anything(), true);
  });
});
