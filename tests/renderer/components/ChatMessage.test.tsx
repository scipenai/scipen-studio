import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '../../../src/renderer/src/components/chat/ChatMessage';
import type { ChatTurn } from '../../../src/renderer/src/services/agent/ChatStreamStore';

const agentClientMocks = vi.hoisted(() => ({
  confirmPlan: vi.fn().mockResolvedValue(undefined),
  confirmTool: vi.fn().mockResolvedValue(undefined),
  respondUserQuestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/renderer/src/components/chat/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../../../src/renderer/src/components/ui', () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button">Copy {text}</button>,
}));

vi.mock('../../../src/renderer/src/hooks', () => ({
  useTextSelectionActive: () => false,
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: {
    confirmPlan: agentClientMocks.confirmPlan,
    confirmTool: agentClientMocks.confirmTool,
    respondUserQuestion: agentClientMocks.respondUserQuestion,
  },
}));

vi.mock('../../../src/renderer/src/services/agent/ChatStreamStore', () => ({
  chatStreamStore: {
    markPlanResolved: vi.fn(),
    markApprovalResolved: vi.fn(),
    markQuestionAnswered: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/services/agent/AgentEditProposalBridge', () => ({
  agentEditProposalBridge: {
    retryMaterialize: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/src/services/core/FileOpenService', () => ({
  openFileInEditor: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getProjectRuntimeContext: () => ({ rootPath: 'D:/paper' }),
  getUIService: () => ({ setSidebarTab: vi.fn() }),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    dialog: { confirm: vi.fn() },
    history: {
      findStepBeforeTs: vi.fn(),
      resolveStepSnapshot: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/utils/historyProjectId', () => ({
  historyProjectIdOf: () => 'project-1',
}));

vi.mock('../../../src/renderer/src/utils/historyRestore', () => ({
  applySnapshotToOpenTabs: vi.fn(),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'chat.planLabel': 'Plan',
        'chat.planAwaitingConfirm': 'Awaiting confirmation',
        'chat.planItemsSuffix': 'items',
        'chat.planAccept': 'Accept plan',
        'chat.planReject': 'Reject',
        'chat.planStatusPending': 'Pending',
        'chat.approvalDeny': 'Deny',
        'chat.approvalAllowOnce': 'Allow once',
        'chat.approvalAllowAlways': 'Always allow',
        'chat.approvalSubmitting': 'Submitting',
        'chat.approvalRetry': 'Retry',
        'chat.approvalHighRiskWarning': 'High-risk action',
        'chat.approvalArming': `Arming in ${params?.seconds ?? 0}s`,
        'chat.approvalShortcutHint': 'A allow / D deny',
        'chat.approvalSubmitFailed': 'Submission failed',
        'chat.questionHeader': 'Decision needed',
        'chat.questionTimeRemaining': `Expires in ${params?.seconds ?? 0}s`,
        'chat.questionShortcutHint': 'Ctrl+Enter to submit / Esc to skip',
        'chat.questionSkip': 'Skip',
        'chat.questionSubmit': 'Submit',
        'chat.questionSubmitting': 'Submitting',
        'chat.questionRetry': 'Retry',
        'chat.questionOther': 'Other',
        'chat.toolDetail.args': 'Args',
        'chat.toolDetail.status': 'Status',
        'chat.toolDetail.result': 'Result',
      };
      return values[key] ?? key;
    },
  }),
}));

const baseTurn: ChatTurn = {
  turnId: 'turn-1',
  origin: 'chat',
  thinkingText: '',
  text: '',
  toolCalls: [],
  events: [],
  proposals: [],
  plan: null,
  approvals: [],
  questions: [],
  pending: false,
};

describe('ChatMessage', () => {
  it('renders plan and tool controls as accessible focusable actions', () => {
    const turn: ChatTurn = {
      ...baseTurn,
      toolCalls: [
        {
          toolCallId: 'tool-1',
          tool: 'Bash',
          args: { cmd: 'npm test' },
          status: 'success',
          result: 'ok',
        },
      ],
      events: [{ kind: 'tool_ref', toolCallId: 'tool-1' }],
      plan: {
        awaiting: true,
        rationale: 'Review the paper draft.',
        files: [
          {
            agentRelativePath: 'src/main.tex',
            absolutePath: 'D:/paper/src/main.tex',
            action: 'modify',
            summary: 'Update abstract',
            status: 'pending',
          },
        ],
      },
    };

    render(<ChatMessage message={null} turn={turn} />);

    const toolToggle = screen.getByRole('button', { name: /Bash/ });
    expect(toolToggle).toHaveAttribute('aria-expanded', 'false');
    expect(toolToggle).toHaveClass('cursor-pointer');
    expect(toolToggle).toHaveClass('focus-visible:ring-2');
    expect(toolToggle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(toolToggle);
    expect(toolToggle).toHaveAttribute('aria-expanded', 'true');

    const planToggle = screen.getByRole('button', { name: /Plan/ });
    expect(planToggle).toHaveAttribute('aria-expanded', 'true');
    expect(planToggle).toHaveClass('cursor-pointer');
    expect(planToggle).toHaveClass('focus-visible:ring-2');
    expect(planToggle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    for (const label of ['Accept plan', 'Reject']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toHaveClass('cursor-pointer');
      expect(action).toHaveClass('focus-visible:ring-2');
    }
  });

  it('renders approval actions with stable pointer and focus affordances', () => {
    const turn: ChatTurn = {
      ...baseTurn,
      approvals: [
        {
          toolCallId: 'approval-1',
          tool: 'WriteFile',
          args: { path: 'src/main.tex' },
          summary: 'Write changes',
          risk: 'low',
          status: 'pending',
        },
      ],
    };

    render(<ChatMessage message={null} turn={turn} />);

    for (const label of ['Deny', 'Always allow', 'Allow once']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toHaveClass('cursor-pointer');
      expect(action).toHaveClass('focus-visible:ring-2');
    }
  });

  it('renders user question actions with focus feedback and hidden decorative icons', () => {
    const turn: ChatTurn = {
      ...baseTurn,
      questions: [
        {
          requestId: 'question-1',
          status: 'pending',
          questions: [
            {
              id: 'scope',
              question: 'Which section should be revised?',
              header: 'Scope',
              multiSelect: false,
              allowOther: false,
              options: [
                { id: 'abstract', label: 'Abstract' },
                { id: 'intro', label: 'Introduction' },
              ],
            },
          ],
        },
      ],
    };

    render(<ChatMessage message={null} turn={turn} />);

    expect(screen.getByRole('group', { name: 'Decision needed' })).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Enter to submit / Esc to skip')).toHaveAttribute(
      'aria-hidden',
      'true'
    );

    const skip = screen.getByRole('button', { name: 'Skip' });
    expect(skip).toHaveClass('cursor-pointer');
    expect(skip).toHaveClass('focus-visible:ring-2');
    expect(skip.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveClass('disabled:cursor-not-allowed');
    expect(submit).toHaveClass('focus-visible:ring-2');

    fireEvent.click(screen.getByLabelText('Abstract'));
    expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled();
  });
});
