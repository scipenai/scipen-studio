import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentStatusSegment } from '../../../src/renderer/src/components/layout/AgentStatusSegment';

const mockAgentState = vi.hoisted(() => ({
  cancelTurn: vi.fn(),
  currentTurn: null as { turnId: string } | null,
  activity: null as { label: string; toolName?: string } | null,
  usage: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: undefined as number | undefined,
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'agentStatus.idle': 'Idle',
        'agentStatus.tool': 'Tool',
        'agentStatus.queued': 'Queued',
        'agentStatus.thinking': 'Thinking',
        'agentStatus.usageHint': 'Token usage',
        'agentStatus.cached': 'cached',
        'agentStatus.stop': 'Stop',
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: {
    cancelTurn: mockAgentState.cancelTurn,
  },
}));

vi.mock('../../../src/renderer/src/services/agent/ChatStreamStore', () => ({
  chatStreamStore: {
    subscribe: () => () => undefined,
    getVersion: () => 1,
    getCurrentTurn: () => mockAgentState.currentTurn,
    getAgentActivity: () => mockAgentState.activity,
    getThreadUsageTotal: () => mockAgentState.usage,
  },
}));

describe('AgentStatusSegment', () => {
  it('renders tool activity and usage with stable readable labels', () => {
    mockAgentState.activity = { label: 'running', toolName: 'Bash' };
    mockAgentState.currentTurn = { turnId: 'turn-1' };
    mockAgentState.usage = {
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 3400,
      costUsd: 0.023,
    };

    render(<AgentStatusSegment />);

    expect(screen.getByText('Tool: Bash')).toBeInTheDocument();
    expect(screen.getByText('In 1.2k')).toBeInTheDocument();
    expect(screen.getByText('Out 3.4k')).toBeInTheDocument();
    expect(screen.getByText('$0.02')).toBeInTheDocument();
    expect(screen.queryByText(/鈫|路|·/)).not.toBeInTheDocument();
  });

  it('exposes a focusable stop action while the agent is busy', () => {
    mockAgentState.cancelTurn.mockClear();
    mockAgentState.activity = { label: 'thinking' };
    mockAgentState.currentTurn = { turnId: 'turn-2' };
    mockAgentState.usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: undefined,
    };

    render(<AgentStatusSegment />);

    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(stopButton).toHaveClass('cursor-pointer');
    expect(stopButton).toHaveClass('focus-visible:ring-1');

    fireEvent.click(stopButton);
    expect(mockAgentState.cancelTurn).toHaveBeenCalledWith('turn-2');
  });
});
