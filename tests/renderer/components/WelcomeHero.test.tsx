import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeHero } from '../../../src/renderer/src/components/welcome/WelcomeHero';

vi.mock('../../../src/renderer/src/assets/logo-full.svg', () => ({
  default: 'logo-full.svg',
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    button: ({
      children,
      whileHover,
      whileTap,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      whileHover?: unknown;
      whileTap?: unknown;
    }) => <button {...props}>{children}</button>,
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'welcome.title': 'Write papers',
        'welcome.subtitle': 'Start writing',
        'welcome.description': 'Research workspace',
        'welcome.openLocal': 'Open local project',
        'welcome.openLocalDesc': 'Choose a folder',
        'welcome.openRemote': 'Open Overleaf project',
        'welcome.openRemoteDesc': 'Connect online',
        'welcome.featureAI': 'AI writing',
        'welcome.featureOverleaf': 'Overleaf Sync',
        'welcome.featurePreview': 'Preview',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('WelcomeHero', () => {
  it('renders primary welcome actions with keyboard focus and decorative icons hidden', () => {
    render(
      <WelcomeHero
        appVersion="1.0.0"
        isOpeningProject={false}
        isOpeningAnyProject={false}
        onOpenProject={vi.fn()}
        onOpenRemote={vi.fn()}
      />
    );

    for (const label of ['Open local project', 'Open Overleaf project']) {
      const action = screen.getByRole('button', { name: new RegExp(label) });
      expect(action).toHaveClass('cursor-pointer');
      expect(action).toHaveClass('focus-visible:ring-2');
      expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
