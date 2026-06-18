import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../../../src/renderer/src/components/layout/StatusBar';

const updateCompiler = vi.fn();

vi.mock('../../../src/renderer/src/assets/logo-s.svg', () => ({
  default: 'logo-s.svg',
}));

vi.mock('../../../src/renderer/src/hooks', () => ({
  useClickOutside: () => undefined,
  useEvent: () => undefined,
}));

vi.mock('../../../src/renderer/src/utils', () => ({
  getLanguageForFile: () => 'latex',
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getEditorService: () => ({
    onDidMarkClean: undefined,
  }),
  getSettingsService: () => ({
    updateCompiler,
  }),
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useActiveTabPath: () => 'D:/paper/main.tex',
  useCompilationResult: () => null,
  useCompilerSettings: () => ({
    engine: 'xelatex',
    typstEngine: 'tinymist',
  }),
  useCursorPosition: () => ({ line: 12, column: 8 }),
  useEditorTabs: () => [{ path: 'D:/paper/main.tex', name: 'main.tex' }],
  useProjectPath: () => 'D:/paper',
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'statusBar.local': 'Local',
        'statusBar.line': 'Ln',
        'statusBar.column': 'Col',
        'statusBar.saved': 'Saved',
        'statusBar.selectCompileEngine': 'Select compile engine',
        'statusBar.localCompiler': 'Local compiler',
        'compiler.xelatexRecommended': 'XeLaTeX',
        'compiler.lualatex': 'LuaLaTeX',
        'compiler.pdflatex': 'pdfLaTeX',
        'compiler.tectonic': 'Tectonic',
        'compiler.wasmXetex': 'WASM XeTeX',
        'compiler.wasmPdftex': 'WASM pdfTeX',
        'compiler.wasmLualatex': 'WASM LuaTeX',
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/renderer/src/components/layout/AgentStatusSegment', () => ({
  AgentStatusSegment: () => <div data-testid="agent-status" />,
}));

vi.mock('../../../src/renderer/src/components/layout/ZoteroStatusBadge', () => ({
  ZoteroStatusBadge: () => <div data-testid="zotero-status" />,
}));

vi.mock('../../../src/renderer/src/components/layout/ActiveRecommendationSegment', () => ({
  ActiveRecommendationSegment: () => <div data-testid="active-recommendation" />,
}));

describe('StatusBar', () => {
  beforeEach(() => {
    updateCompiler.mockClear();
  });

  it('exposes the compiler selector as an accessible expandable control', () => {
    render(<StatusBar />);

    const selector = screen.getByRole('button', { name: 'Select compile engine' });
    expect(selector).toHaveAttribute('aria-expanded', 'false');
    expect(selector).toHaveAttribute('aria-haspopup', 'menu');
    expect(selector).toHaveClass('focus-visible:ring-1');

    fireEvent.click(selector);

    expect(selector).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    expect(selector).toHaveAttribute('aria-controls', menu.id);
    expect(screen.getByRole('menuitemradio', { name: 'LuaLaTeX' })).toHaveClass('cursor-pointer');
    expect(screen.getByRole('menuitemradio', { name: 'LuaLaTeX' })).toHaveClass(
      'focus-visible:ring-1'
    );
  });

  it('updates the compiler and closes the menu when an engine is picked', () => {
    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'LuaLaTeX' }));

    expect(updateCompiler).toHaveBeenCalledWith({ engine: 'lualatex' });
    expect(screen.queryByRole('menuitemradio', { name: 'LuaLaTeX' })).not.toBeInTheDocument();
  });

  it('moves focus into the compiler menu and restores it when Escape closes', () => {
    render(<StatusBar />);

    const selector = screen.getByRole('button', { name: 'Select compile engine' });
    selector.focus();
    fireEvent.click(selector);

    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    expect(screen.getByRole('menuitemradio', { name: 'XeLaTeX' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: 'Local compiler' })).not.toBeInTheDocument();
    expect(selector).toHaveFocus();
  });

  it('supports arrow-key navigation inside the compiler menu', () => {
    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));

    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    const xelatex = screen.getByRole('menuitemradio', { name: 'XeLaTeX' });
    const lualatex = screen.getByRole('menuitemradio', { name: 'LuaLaTeX' });
    const wasmLua = screen.getByRole('menuitemradio', { name: 'WASM LuaTeX' });

    expect(xelatex).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(lualatex).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(xelatex).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(wasmLua).toHaveFocus();
  });
});
