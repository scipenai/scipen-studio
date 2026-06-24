import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatInput } from '../../../src/renderer/src/components/chat/AgentChatInput';

vi.mock('../../../src/renderer/src/hooks/useMentionTrigger', () => ({
  useMentionTrigger: () => ({
    query: 'sec',
    replaceFrom: 0,
    replaceTo: 4,
  }),
}));

vi.mock('../../../src/renderer/src/hooks/useZoteroWizard', () => {
  const controller = { open: vi.fn() };
  return {
    useZoteroWizardController: () => controller,
  };
});

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useFilePathIndex: () => ['paper.tex', 'sections/intro.tex'],
}));

vi.mock('../../../src/renderer/src/services/zotero/ZoteroBibMirror', () => ({
  getZoteroBibMirror: () => ({
    getState: () => ({ ready: true, itemCount: 0 }),
    searchByQueryWithScore: () => [],
  }),
}));

vi.mock('../../../src/renderer/src/components/chat/AtFileDropdown', () => ({
  AtFileDropdown: ({
    id,
    activeId,
    items,
    selectedIndex,
  }: {
    id: string;
    activeId: string;
    items: string[];
    selectedIndex: number;
  }) => (
    <ul id={id} role="listbox" aria-label="File suggestions">
      {items.map((item, index) => (
        <li
          id={`chat-file-suggestion-${index}`}
          key={item}
          role="option"
          aria-selected={selectedIndex === index}
        >
          {item}
        </li>
      ))}
      <li data-testid="active-id">{activeId}</li>
    </ul>
  ),
  scoreFilePath: (path: string, query: string) => (path.includes(query) ? 1 : -1),
}));

vi.mock('../../../src/renderer/src/components/chat/AtCiteDropdown', () => ({
  AtCiteDropdown: () => null,
}));

vi.mock('lucide-react', () => ({
  SendHorizontal: () => <svg aria-hidden="true" />,
  Square: () => <svg aria-hidden="true" />,
  Wrench: () => <svg aria-hidden="true" />,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'chat.inputAriaLabel': 'Message input',
        'chat.inputPlaceholder': 'Ask about this paper...',
        'chat.initializing': 'Initializing',
        'chat.cancel': 'Cancel',
        'chat.stop': 'Stop',
        'chat.send': 'Send',
        'atFileDropdown.label': 'File suggestions',
        'atCiteDropdown.label': 'Citation suggestions',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('AgentChatInput autocomplete semantics', () => {
  it('connects the textarea to the active file suggestion', () => {
    render(<AgentChatInput busy={false} onSend={vi.fn()} />);

    const input = screen.getByLabelText('Message input');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-controls', 'chat-file-suggestions');
    expect(input).toHaveAttribute('aria-activedescendant', 'chat-file-suggestion-0');

    expect(screen.getByRole('listbox', { name: 'File suggestions' })).toHaveAttribute(
      'id',
      'chat-file-suggestions'
    );
    expect(screen.getByTestId('active-id')).toHaveTextContent('chat-file-suggestion-0');
  });
});
