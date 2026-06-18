import { render, screen, within } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeTips } from '../../../src/renderer/src/components/welcome/WelcomeTips';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'welcome.proTipTitle': 'Quick tip',
        'welcome.proTipDesc': 'Select text and press {{shortcut}} to polish it with AI.',
      };
      const value = values[key] ?? key;
      return params
        ? Object.entries(params).reduce(
            (next, [paramKey, paramValue]) =>
              next.replace(new RegExp(`{{${paramKey}}}`, 'g'), String(paramValue)),
            value
          )
        : value;
    },
  }),
}));

describe('WelcomeTips', () => {
  it('renders the command shortcut inline inside a readable tip sentence', () => {
    render(<WelcomeTips />);

    const tip = screen.getByTestId('welcome-pro-tip-desc');
    expect(within(tip).getByText('Ctrl+Shift+P')).toBeInTheDocument();
    expect(tip).toHaveTextContent('Select text and press Ctrl+Shift+P to polish it with AI.');
    expect(tip).not.toHaveTextContent('press  to');
  });
});
