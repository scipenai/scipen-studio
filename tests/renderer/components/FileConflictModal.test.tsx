import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileConflictModal } from '../../../src/renderer/src/components/FileConflictModal';

const projectService = vi.hoisted(() => ({
  clearFileConflict: vi.fn(),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    file: {
      read: vi.fn(),
      write: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/utils/overleaf-sync-helper', () => ({
  triggerOverleafSyncAfterSave: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getProjectService: () => projectService,
  getEditorService: () => ({
    beginSave: vi.fn(),
    closeTab: vi.fn(),
    completeSave: vi.fn(),
    setContentFromExternal: vi.fn(),
    updateFileMtime: vi.fn(),
  }),
  getUIService: () => ({ addCompilationLog: vi.fn() }),
  useFileConflict: () => ({
    path: 'D:/paper/main.tex',
    type: 'change',
    hasUnsavedChanges: true,
  }),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'fileConflict.fileDeleted': 'File has been deleted',
        'fileConflict.fileModified': 'File has been modified externally',
        'fileConflict.deletedDesc': 'This file has been deleted from disk.',
        'fileConflict.unsavedChanges': 'You have unsaved changes.',
        'fileConflict.modifiedDesc': 'This file has been modified in an external editor.',
        'fileConflict.unsavedWillLose': 'You have unsaved changes, reloading will lose these changes.',
        'fileConflict.saveAs': 'Save As New File',
        'fileConflict.closeFile': 'Close File',
        'fileConflict.keepMyChanges': 'Keep My Changes',
        'fileConflict.reload': 'Reload',
        'common.cancel': 'Cancel',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('FileConflictModal', () => {
  it('renders file conflict choices as a labelled modal with keyboard focus feedback', () => {
    render(<FileConflictModal />);

    expect(
      screen.getByRole('dialog', { name: 'File has been modified externally' })
    ).toBeInTheDocument();

    for (const label of ['Cancel', 'Keep My Changes', 'Reload']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toHaveAttribute('type', 'button');
      expect(action).toHaveClass('cursor-pointer');
      expect(action).toHaveClass('focus-visible:ring-2');
    }
  });

  it('moves focus into the modal, closes with Escape, and keeps Tab inside actions', async () => {
    render(<FileConflictModal />);

    const dialog = screen.getByRole('dialog', { name: 'File has been modified externally' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const reload = screen.getByRole('button', { name: 'Reload' });

    expect(cancel).toHaveFocus();

    reload.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(reload).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(projectService.clearFileConflict).toHaveBeenCalledTimes(1);
  });
});
