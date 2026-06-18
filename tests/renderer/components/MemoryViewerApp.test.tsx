import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryViewerApp } from '../../../src/renderer/src/components/memory-viewer/MemoryViewerApp';

vi.mock('../../../src/renderer/src/hooks/useThemeSync', () => ({
  useThemeSync: vi.fn(),
}));

vi.mock('../../../src/renderer/src/components/memory-viewer/MemoryPane', () => ({
  MemoryPane: () => <div data-testid="memory-pane" />,
}));

vi.mock('../../../src/renderer/src/components/memory-viewer/SkillsPane', () => ({
  SkillsPane: () => <div data-testid="skills-pane" />,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'memoryViewer.title': 'Memory Viewer',
        'memoryViewer.tabMemory': 'Memory',
        'memoryViewer.tabSkills': 'Skills',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('MemoryViewerApp', () => {
  beforeEach(() => {
    window.location.hash = '#/memory-viewer';
  });

  it('renders memory and skills as accessible tabs with selected state', () => {
    render(<MemoryViewerApp />);

    expect(screen.getByRole('tablist', { name: 'Memory Viewer' })).toBeInTheDocument();

    const memory = screen.getByRole('tab', { name: 'Memory' });
    expect(memory).toHaveAttribute('aria-selected', 'true');
    expect(memory).toHaveClass('cursor-pointer');
    expect(memory).toHaveClass('focus-visible:ring-2');
    expect(screen.getByTestId('memory-pane')).toBeInTheDocument();

    const skills = screen.getByRole('tab', { name: 'Skills' });
    expect(skills).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(skills);

    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('skills-pane')).toBeInTheDocument();
  });
});
