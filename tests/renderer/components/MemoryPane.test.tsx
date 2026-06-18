import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPane } from '../../../src/renderer/src/components/memory-viewer/MemoryPane';

const agentClientMocks = vi.hoisted(() => ({
  memoryList: vi.fn(),
  memoryGet: vi.fn(),
  memoryWrite: vi.fn(),
  memoryDelete: vi.fn(),
  memoryReveal: vi.fn(),
  onMemoryUpdated: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <textarea readOnly value={value} aria-label="Memory content" />,
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: agentClientMocks,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'memoryViewer.scope.user': 'User',
        'memoryViewer.scope.feedback': 'Feedback',
        'memoryViewer.scope.project': 'Project',
        'memoryViewer.scope.reference': 'Reference',
        'memoryViewer.newEntry': 'New',
        'memoryViewer.reload': 'Reload',
        'memoryViewer.reveal': 'Reveal in file manager',
        'memoryViewer.newEntryNamePlaceholder': 'unique name',
        'memoryViewer.newEntryInvalid': 'Invalid name',
        'memoryViewer.empty': 'No memory entries yet',
        'memoryViewer.noActiveSession': 'Open a project first',
        'memoryViewer.noPreview': '(no preview)',
        'memoryViewer.previewPlaceholder': 'Select an entry',
        'memoryViewer.save': 'Save',
        'memoryViewer.saving': 'Saving',
        'memoryViewer.delete': 'Delete',
        'memoryViewer.deleteConfirm': `Delete ${params?.name ?? ''}?`,
      };
      return values[key] ?? key;
    },
  }),
}));

describe('MemoryPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentClientMocks.onMemoryUpdated.mockReturnValue(vi.fn());
    agentClientMocks.memoryList.mockResolvedValue({
      entries: [
        {
          scope: 'user',
          name: 'writing_style',
          last_modified: '2026-06-16',
          preview: 'Prefer precise prose.',
        },
      ],
    });
    agentClientMocks.memoryGet.mockResolvedValue({
      scope: 'user',
      name: 'writing_style',
      content: '# writing_style',
      last_modified: '2026-06-16',
    });
    agentClientMocks.memoryReveal.mockResolvedValue(undefined);
  });

  it('exposes scopes, toolbar actions, and entries with keyboard-visible semantics', async () => {
    render(<MemoryPane />);

    const userScope = screen.getByRole('tab', { name: 'User' });
    expect(userScope).toHaveAttribute('aria-selected', 'true');
    expect(userScope).toHaveClass('cursor-pointer');
    expect(userScope).toHaveClass('focus-visible:ring-2');

    const feedbackScope = screen.getByRole('tab', { name: 'Feedback' });
    expect(feedbackScope).toHaveAttribute('aria-selected', 'false');

    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload).toHaveClass('cursor-pointer');
    expect(reload).toHaveClass('focus-visible:ring-2');
    expect(reload.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Reveal in file manager' }));
    expect(agentClientMocks.memoryReveal).toHaveBeenCalledWith(undefined, undefined);

    const entry = await screen.findByRole('button', { name: /writing_style/ });
    expect(entry).toHaveClass('cursor-pointer');
    expect(entry).toHaveClass('focus-visible:ring-2');
    fireEvent.click(entry);

    await waitFor(() => expect(agentClientMocks.memoryGet).toHaveBeenCalledWith('user', 'writing_style'));

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveClass('disabled:cursor-not-allowed');
    expect(save.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toHaveClass('cursor-pointer');
    expect(del.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
