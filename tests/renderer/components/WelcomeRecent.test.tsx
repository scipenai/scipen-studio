import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeRecent } from '../../../src/renderer/src/components/welcome/WelcomeRecent';

vi.mock('framer-motion', () => ({
  motion: {
    button: ({
      children,
      whileHover,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { whileHover?: unknown }) => (
      <button {...props}>{children}</button>
    ),
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'welcome.recentProjects': 'Recent projects',
        'welcome.justNow': 'Just now',
        'welcome.hoursAgo': `${params?.count ?? 0} hours ago`,
        'welcome.yesterday': 'Yesterday',
        'welcome.daysAgo': `${params?.count ?? 0} days ago`,
        'welcome.noRecentProjects': 'No recent projects',
        'welcome.noRecentProjectsHint': 'Open one to get started',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('WelcomeRecent', () => {
  it('keeps recent project rows focusable with clear disabled and loading affordances', () => {
    render(
      <WelcomeRecent
        projects={[
          {
            name: 'Paper',
            path: 'D:/paper',
            lastOpened: Date.now(),
          },
        ]}
        openingPath="D:/paper"
        isOpeningAnyProject
        onOpenRecent={vi.fn()}
      />
    );

    const project = screen.getByRole('button', { name: /Paper/ });
    expect(project).toBeDisabled();
    expect(project).toHaveClass('cursor-not-allowed');
    expect(project).toHaveClass('focus-visible:ring-2');
    expect(project.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
