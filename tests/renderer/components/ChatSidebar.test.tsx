import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '../../../src/renderer/src/components/chat/ChatSidebar';

let activeThreadId = 'thread-1';
let storeVersion = 0;

vi.mock('../../../src/renderer/src/hooks', () => ({
  useEvent: () => undefined,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  t: (key: string) => key,
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'thread.historyTitle': 'History',
        'thread.copyThread': 'Copy thread',
        'thread.newThread': 'New thread',
        'thread.newConversation': 'New conversation',
        'chat.status.connected': 'Connected',
        'chat.status.initializing': 'Initializing',
        'chat.status.disconnected': 'Disconnected',
        'chat.status.unconfigured': 'Unconfigured',
        'chat.status.error': 'Error',
        'chat.welcomeTitle': 'Ask SciPen',
        'chat.welcomeSubtitle': 'Ask about the current project.',
        'chat.hintFiles': 'attach files',
        'chat.hintSend': 'send',
        'chat.hintNewline': 'new line',
        'chat.tryExamples': 'Try examples',
        'chat.examplePrompt1': 'Summarize this draft',
        'chat.examplePrompt2': 'Improve the argument',
        'chat.examplePrompt3': 'Find missing citations',
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useSettings: () => 13,
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getSettingsService: () => ({
    onDidChangeAIProviders: () => ({ dispose: vi.fn() }),
  }),
  getUIService: () => ({
    onDidRequestAIErrorAnalysis: undefined,
    onDidRequestChatWithText: undefined,
    setSidebarTab: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: {
    startProject: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      threadId: 'thread-1',
      threads: [{ thread_id: 'thread-1', title: 'Draft review' }],
    }),
    listThreads: vi.fn().mockResolvedValue([{ thread_id: 'thread-1', title: 'Draft review' }]),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
  },
}));

vi.mock('../../../src/renderer/src/services/agent/ChatStreamStore', () => ({
  chatStreamStore: {
    subscribe: () => () => undefined,
    getVersion: () => storeVersion,
    getActiveThreadId: () => activeThreadId,
    getMessages: () => [],
    getCurrentTurn: () => null,
    reset: vi.fn(() => {
      storeVersion += 1;
    }),
    setActiveThread: vi.fn((threadId: string) => {
      activeThreadId = threadId;
      storeVersion += 1;
    }),
    replaceMessages: vi.fn(),
    getTurn: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/components/chat/AgentChatInput', () => ({
  AgentChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('../../../src/renderer/src/components/chat/ChatMessage', () => ({
  ChatMessage: () => <div data-testid="chat-message" />,
}));

vi.mock('../../../src/renderer/src/components/chat/ThreadHistoryDrawer', () => ({
  ThreadHistoryDrawer: () => <div data-testid="thread-history-drawer" />,
}));

vi.mock('../../../src/renderer/src/services/agent/ChatContextBuilder', () => ({
  buildChatContext: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/AtMentionResolver', () => ({
  buildMentions: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    ai: {
      generateTitle: vi.fn(),
    },
  },
}));

describe('ChatSidebar', () => {
  it('marks header actions as pointer-interactive once chat is ready', async () => {
    render(<ChatSidebar workspaceRoot="D:/project" displayName="Project" />);

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'History' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Copy thread' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button', { name: 'New thread' })).toHaveClass('cursor-pointer');
  });
});
