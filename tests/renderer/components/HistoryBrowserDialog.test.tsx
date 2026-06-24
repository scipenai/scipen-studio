import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryBrowserDialog } from '../../../src/renderer/src/components/history/HistoryBrowserDialog';

const openBrowserHandlers = vi.hoisted(() => new Set<(tab: 'labels' | 'sessions') => void>());
const labelsChangedHandlers = vi.hoisted(() => new Set<() => void>());
const sessionsChangedHandlers = vi.hoisted(() => new Set<() => void>());

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/hooks/useFocusTrap', () => ({
  useFocusTrap: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/HistoryUIBus', () => ({
  historyUIBus: {
    onOpenBrowser: (handler: (tab: 'labels' | 'sessions') => void) => {
      openBrowserHandlers.add(handler);
      return { dispose: () => openBrowserHandlers.delete(handler) };
    },
    onLabelsChanged: (handler: () => void) => {
      labelsChangedHandlers.add(handler);
      return { dispose: () => labelsChangedHandlers.delete(handler) };
    },
    onSessionsChanged: (handler: () => void) => {
      sessionsChangedHandlers.add(handler);
      return { dispose: () => sessionsChangedHandlers.delete(handler) };
    },
    openCreateLabel: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  getEditorService: () => ({
    tabs: [{ _id: 'src/main.tex', path: 'D:/paper/src/main.tex', content: 'current' }],
  }),
  getProjectRuntimeContext: () => ({ rootPath: 'D:/paper' }),
}));

vi.mock('../../../src/renderer/src/utils/historyProjectId', () => ({
  historyProjectIdOf: () => 'project-1',
}));

vi.mock('../../../src/renderer/src/utils/historyRestore', () => ({
  applySnapshotToOpenTabs: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    history: {
      listLabels: vi.fn().mockResolvedValue([
        {
          id: 'label-1',
          projectId: 'project-1',
          name: 'Draft checkpoint',
          description: null,
          kind: 'manual',
          createdAt: 1_700_000_000_000,
          createdBy: 'user',
        },
      ]),
      resolveLabelSnapshot: vi.fn().mockResolvedValue({
        'src/main.tex': new TextEncoder().encode('snapshot'),
      }),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionSteps: vi.fn().mockResolvedValue([]),
      resolveStepSnapshot: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'history.browserTitle': 'History',
        'history.browseLabels': 'Labels',
        'history.browseSessions': 'Sessions',
        'history.browserSections': 'History sections',
        'history.createLabel': 'Create snapshot label',
        'history.submit': 'Create',
        'history.close': 'Close',
        'history.restore': 'Restore',
        'history.restoring': 'Restoring',
        'history.restoreSuccess': `Restored ${params?.count ?? 0}`,
        'history.restoreFailed': `Restore failed ${params?.error ?? ''}`,
        'history.labelFilesCount': `${params?.count ?? 0} files`,
        'history.labelKindManual': 'Manual',
        'history.labelKindAuto': 'Auto',
        'history.labelKindMilestone': 'Milestone',
        'history.diffStatsClosed': 'Closed',
        'history.diffStatsNoChange': 'No changes',
        'history.viewDiff': 'View diff',
        'history.labelKeyboardHint': 'Arrow keys / J K',
        'history.labelSelectPrompt': 'Select a label',
        'history.stepsEmpty': 'No steps',
        'history.labelEmpty': 'No labels',
        'history.labelNoProject': 'No project',
        'history.sessionsEmpty': 'No sessions',
        'history.sessionsStepCount': `${params?.count ?? 0} steps`,
      };
      return values[key] ?? key;
    },
  }),
}));

describe('HistoryBrowserDialog', () => {
  it('focuses the browser and restores the opener when Escape closes', async () => {
    render(
      <>
        <button type="button">Open history</button>
        <HistoryBrowserDialog />
      </>
    );

    const opener = screen.getByRole('button', { name: 'Open history' });
    opener.focus();

    await act(async () => {
      for (const handler of openBrowserHandlers) handler('labels');
    });

    const dialog = screen.getByRole('dialog', { name: 'History' });
    expect(dialog.firstElementChild).toHaveFocus();

    fireEvent.keyDown(dialog.firstElementChild as HTMLElement, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'History' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('opens labels history with a tablist, selectable rows, and labelled restore action', async () => {
    render(<HistoryBrowserDialog />);

    await act(async () => {
      for (const handler of openBrowserHandlers) handler('labels');
    });

    expect(screen.getByRole('dialog', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'History sections' })).toBeInTheDocument();

    const labelsTab = screen.getByRole('tab', { name: /Labels/ });
    expect(labelsTab).toHaveAttribute('aria-selected', 'true');
    expect(labelsTab.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Draft checkpoint/ })).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /Draft checkpoint/ })).toHaveClass(
      'focus-visible:ring-2'
    );

    const restore = screen.getByRole('button', { name: 'Restore' });
    expect(restore).toHaveAttribute('type', 'button');
    expect(restore).toHaveClass('cursor-pointer');
    expect(restore).toHaveClass('focus-visible:ring-2');
    expect(restore.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
