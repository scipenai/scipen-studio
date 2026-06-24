import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '../../../src/renderer/src/components/chat/MarkdownContent';

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'markdownContent.copyCode': 'Copy code',
        'markdownContent.copied': 'Copied',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('MarkdownContent', () => {
  it('renders code copy as a pointer action with visible keyboard focus', () => {
    render(<MarkdownContent content={'```ts\nconst answer = 42;\nconsole.log(answer);\n```'} />);

    const copy = screen.getByRole('button', { name: 'Copy code' });
    expect(copy).toHaveAttribute('type', 'button');
    expect(copy).toHaveClass('markdown-code-block__copy');
    expect(copy).toHaveClass('cursor-pointer');
    expect(copy).toHaveClass('focus-visible:ring-2');
  });
});
