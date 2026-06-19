import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTab } from '../../../src/renderer/src/components/settings/AgentTab';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const agentClientMocks = vi.hoisted(() => ({
  openMemoryViewer: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    config: apiMocks,
  },
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: agentClientMocks,
}));

vi.mock('../../../src/renderer/src/components/settings/McpServersSection', () => ({
  McpServersSection: () => <div data-testid="mcp-section" />,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'settingsAgent.sectionCoreBehavior': 'Core behavior',
        'settingsAgent.approval.mode': 'Approval mode',
        'settingsAgent.approval.modeDesc': 'Choose approval behavior',
        'settingsAgent.approval.interactive': 'Interactive',
        'settingsAgent.approval.autoAllow': 'Auto allow',
        'settingsAgent.approval.autoDeny': 'Auto deny',
        'settingsAgent.sectionMemoryTools': 'Memory and tools',
        'settingsAgent.memoryLabel': 'Memory',
        'settingsAgent.memoryDesc': 'Browse memory',
        'settingsAgent.openMemory': 'Open Memory Viewer',
        'settingsAgent.skillsLabel': 'Skills',
        'settingsAgent.skillsDesc': 'Browse skills',
        'settingsAgent.openSkills': 'Open Skills Viewer',
        'settingsAgent.sectionIntegrations': 'Integrations',
        'settingsAgent.webSearch.apiKey': 'Web search key',
        'settingsAgent.webSearch.apiKeyDesc': 'Tavily API key',
        'settingsAgent.webSearch.apiKeyPlaceholder': 'tvly...',
        'settingsAgent.engine.title': 'Advanced engine',
        'settingsAgent.engine.expand': 'Show advanced engine settings',
        'settingsAgent.engine.collapse': 'Hide advanced engine settings',
        'settingsAgent.engine.desc': 'Advanced runtime settings',
        'settingsAgent.engine.groupExecution': 'Execution',
        'settingsAgent.engine.groupContext': 'Context',
        'settingsAgent.engine.groupTokens': 'Tokens',
        'settingsAgent.engine.groupMcp': 'MCP',
        'settingsAgent.engine.groupSwitches': 'Switches',
        'settingsAgent.engine.maxIterations': 'Max iterations',
        'settingsAgent.engine.maxIterationsDesc': 'Maximum loop iterations',
        'settingsAgent.engine.loopGuard': 'Loop guard',
        'settingsAgent.engine.loopGuardDesc': 'Repeat guard',
        'settingsAgent.engine.historyLimit': 'History limit',
        'settingsAgent.engine.historyLimitDesc': 'Messages retained',
        'settingsAgent.engine.maxTokens': 'Max tokens',
        'settingsAgent.engine.maxTokensDesc': 'Output token budget',
        'settingsAgent.engine.concurrentTools': 'Concurrent tools',
        'settingsAgent.engine.concurrentToolsDesc': 'Parallel tool count',
        'settingsAgent.engine.compactAfter': 'Compact after',
        'settingsAgent.engine.compactAfterDesc': 'Input token threshold',
        'settingsAgent.engine.compactSummaryMaxTokens': 'Compact summary',
        'settingsAgent.engine.compactSummaryMaxTokensDesc': 'Summary token cap',
        'settingsAgent.engine.historyMaxBytes': 'History bytes',
        'settingsAgent.engine.historyMaxBytesDesc': 'History byte cap',
        'settingsAgent.engine.turnTimeoutSecs': 'Turn timeout',
        'settingsAgent.engine.turnTimeoutSecsDesc': 'Seconds',
        'settingsAgent.engine.collapseToolResultsThreshold': 'Collapse tool results',
        'settingsAgent.engine.collapseToolResultsThresholdDesc': 'Threshold',
        'settingsAgent.engine.maxOutputTokenEscalationAttempts': 'Escalation attempts',
        'settingsAgent.engine.maxOutputTokenEscalationAttemptsDesc': 'Attempts',
        'settingsAgent.engine.maxOutputTokenCeiling': 'Token ceiling',
        'settingsAgent.engine.maxOutputTokenCeilingDesc': 'Maximum ceiling',
        'settingsAgent.engine.mcpIdleTtlSecs': 'MCP idle TTL',
        'settingsAgent.engine.mcpIdleTtlSecsDesc': 'TTL seconds',
        'settingsAgent.engine.mcpReaperPeriodSecs': 'MCP reaper period',
        'settingsAgent.engine.mcpReaperPeriodSecsDesc': 'Period seconds',
        'settingsAgent.engine.streamToolExecution': 'Stream tool execution',
        'settingsAgent.engine.streamToolExecutionDesc': 'Stream updates',
        'settingsAgent.engine.memoryExtractor': 'Memory extractor',
        'settingsAgent.engine.memoryExtractorDesc': 'Extract memories',
        'settingsAgent.engine.boolOn': 'On',
        'settingsAgent.engine.boolOff': 'Off',
        'settingsAgent.engine.memoryExtractorModel': 'Memory extractor model',
        'settingsAgent.engine.memoryExtractorModelDesc': 'Model name',
        'settingsAgent.engine.restartHint': 'Restart required',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('AgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockResolvedValue(undefined);
    apiMocks.set.mockResolvedValue(undefined);
  });

  it('keeps memory launchers and the advanced engine disclosure keyboard-visible', () => {
    render(<AgentTab />);

    const memory = screen.getByRole('button', { name: 'Open Memory Viewer' });
    expect(memory).toHaveClass('cursor-pointer');
    expect(memory).toHaveClass('focus-visible:ring-2');
    expect(memory.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(memory);
    expect(agentClientMocks.openMemoryViewer).toHaveBeenCalledWith('memory');

    const skills = screen.getByRole('button', { name: 'Open Skills Viewer' });
    expect(skills.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const advanced = screen.getByRole('button', { name: 'Show advanced engine settings' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(advanced).toHaveClass('cursor-pointer');
    expect(advanced).toHaveClass('focus-visible:ring-2');
    expect(advanced.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(advanced);
    expect(screen.getByRole('button', { name: 'Hide advanced engine settings' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Advanced runtime settings')).toBeInTheDocument();
  });
});
