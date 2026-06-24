import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpServersSection } from '../../../src/renderer/src/components/settings/McpServersSection';

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    config: {
      get: vi.fn().mockResolvedValue([
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: {},
        },
      ]),
      set: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'settingsAgent.mcp.title': 'MCP servers',
        'settingsAgent.mcp.desc': 'Configure MCP servers',
        'settingsAgent.mcp.empty': 'No MCP servers',
        'settingsAgent.mcp.add': 'Add server',
        'settingsAgent.mcp.delete': 'Delete server',
        'settingsAgent.mcp.deleteConfirm': `Delete ${params?.name ?? ''}?`,
        'settingsAgent.mcp.restartHint': 'Restart required',
        'settingsAgent.mcp.name': 'Name',
        'settingsAgent.mcp.nameInvalid': 'Invalid name',
        'settingsAgent.mcp.nameDuplicate': 'Duplicate name',
        'settingsAgent.mcp.transport': 'Transport',
        'settingsAgent.mcp.command': 'Command',
        'settingsAgent.mcp.commandDesc': 'Command to run',
        'settingsAgent.mcp.args': 'Arguments',
        'settingsAgent.mcp.argsDesc': 'Space separated arguments',
        'settingsAgent.mcp.env': 'Environment',
        'settingsAgent.mcp.envDesc': 'One KEY=value per line',
        'settingsAgent.mcp.url': 'URL',
        'settingsAgent.mcp.urlDesc': 'HTTP endpoint',
        'settingsAgent.mcp.initTimeout': 'Init timeout',
        'settingsAgent.mcp.initTimeoutDesc': 'Seconds',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('McpServersSection', () => {
  it('uses accessible expand/delete/add actions for server rows', async () => {
    render(<McpServersSection />);

    const expand = await screen.findByRole('button', { name: 'Expand filesystem' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveClass('focus-visible:ring-2');
    expect(expand.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse filesystem' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    const remove = screen.getByRole('button', { name: 'Delete server filesystem' });
    expect(remove).toHaveClass('cursor-pointer');
    expect(remove).toHaveClass('focus-visible:ring-2');

    const add = screen.getByRole('button', { name: 'Add server' });
    expect(add).toHaveClass('cursor-pointer');
    expect(add).toHaveClass('focus-visible:ring-2');
  });
});
