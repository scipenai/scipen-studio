import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatInput } from '../../../src/renderer/src/components/chat/AgentChatInput';

vi.mock('../../../src/renderer/src/hooks/useMentionTrigger', () => ({
  useMentionTrigger: () => null,
}));

vi.mock('../../../src/renderer/src/hooks/useZoteroWizard', () => {
  const controller = { open: vi.fn() };
  return {
    useZoteroWizardController: () => controller,
  };
});

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useFilePathIndex: () => [],
}));

vi.mock('../../../src/renderer/src/services/zotero/ZoteroBibMirror', () => ({
  getZoteroBibMirror: () => ({
    getState: () => ({ ready: true, itemCount: 0 }),
    searchByQueryWithScore: () => [],
  }),
}));

vi.mock('../../../src/renderer/src/components/chat/AtFileDropdown', () => ({
  AtFileDropdown: () => null,
  scoreFilePath: () => -1,
}));

vi.mock('../../../src/renderer/src/components/chat/AtCiteDropdown', () => ({
  AtCiteDropdown: () => null,
}));

vi.mock('lucide-react', () => ({
  SendHorizontal: () => <svg data-testid="send-icon" />,
  Square: () => <svg data-testid="stop-icon" />,
  Wrench: () => <svg />,
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
      };
      return values[key] ?? key;
    },
  }),
}));

describe('AgentChatInput', () => {
  it('uses an icon send button with clear accessible labels', () => {
    const onSend = vi.fn();
    render(<AgentChatInput busy={false} onSend={onSend} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();
    expect(sendButton.querySelector('svg')).not.toBeNull();
    expect(sendButton).toHaveTextContent('');

    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hello' } });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledWith('hello', 'chat');
  });

  it('uses an icon stop button while busy', () => {
    const onCancel = vi.fn();
    render(<AgentChatInput busy={true} onSend={vi.fn()} onCancel={onCancel} />);

    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(stopButton.querySelector('svg')).not.toBeNull();

    fireEvent.click(stopButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
