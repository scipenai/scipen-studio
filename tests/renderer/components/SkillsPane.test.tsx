import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsPane } from '../../../src/renderer/src/components/memory-viewer/SkillsPane';

const agentClientMocks = vi.hoisted(() => ({
  skillsList: vi.fn(),
  skillsGet: vi.fn(),
  skillsReload: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/agent/AgentClientService', () => ({
  agentClient: agentClientMocks,
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    app: apiMocks,
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'memoryViewer.reload': 'Reload',
        'memoryViewer.emptySkills': 'No skills loaded',
        'memoryViewer.noActiveSession': 'Open a project first',
        'memoryViewer.skillScope.project': 'Project',
        'memoryViewer.previewPlaceholder': 'Select an entry',
        'memoryViewer.reveal': 'Reveal in file manager',
        'memoryViewer.fieldDescription': 'Description',
        'memoryViewer.fieldWhenToUse': 'When to use',
        'memoryViewer.fieldAllowedTools': 'Allowed tools',
        'memoryViewer.fieldSourcePath': 'Source path',
        'memoryViewer.body': 'Body',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('SkillsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentClientMocks.skillsList.mockResolvedValue({
      skills: [
        {
          scope: 'project',
          name: 'paper-style',
          description: 'Paper editing rules',
          allowed_tools: ['shell'],
          source_path: 'D:/paper/.codex/skills/paper-style/SKILL.md',
        },
      ],
    });
    agentClientMocks.skillsGet.mockResolvedValue({
      skill: {
        scope: 'project',
        name: 'paper-style',
        description: 'Paper editing rules',
        when_to_use: 'When editing papers',
        allowed_tools: ['shell'],
        source_path: 'D:/paper/.codex/skills/paper-style/SKILL.md',
        body: 'Follow the local style.',
      },
    });
    agentClientMocks.skillsReload.mockResolvedValue(undefined);
    apiMocks.openExternal.mockResolvedValue(undefined);
  });

  it('keeps reload, skill rows, and reveal action keyboard-visible and named', async () => {
    render(<SkillsPane />);

    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload).toHaveClass('cursor-pointer');
    expect(reload).toHaveClass('focus-visible:ring-2');
    expect(reload.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const skill = await screen.findByRole('button', { name: /paper-style/ });
    expect(skill).toHaveClass('cursor-pointer');
    expect(skill).toHaveClass('focus-visible:ring-2');

    fireEvent.click(skill);
    await waitFor(() => expect(agentClientMocks.skillsGet).toHaveBeenCalledWith('paper-style'));

    const reveal = screen.getByRole('button', { name: 'Reveal in file manager' });
    expect(reveal).toHaveClass('cursor-pointer');
    expect(reveal).toHaveClass('focus-visible:ring-2');
    expect(reveal.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(reveal);
    expect(apiMocks.openExternal).toHaveBeenCalledWith(
      'file://D:/paper/.codex/skills/paper-style/SKILL.md'
    );
  });
});
