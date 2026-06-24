import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../../../src/renderer/src/components/layout/StatusBar';

const mocks = vi.hoisted(() => ({
  updateCompiler: vi.fn(),
  getLaTeXCapabilities: vi.fn(),
  getTypstCapabilities: vi.fn(),
  compilerSettings: {
    engine: 'xelatex',
    typstEngine: 'tinymist',
  },
  activeTabPath: 'D:/paper/main.tex',
  editorTabs: [{ path: 'D:/paper/main.tex', name: 'main.tex' }],
}));

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

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    compile: {
      getLaTeXCapabilities: mocks.getLaTeXCapabilities,
      getTypstCapabilities: mocks.getTypstCapabilities,
    },
  },
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getEditorService: () => ({
    onDidMarkClean: undefined,
  }),
  getSettingsService: () => ({
    updateCompiler: mocks.updateCompiler,
  }),
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useActiveTabPath: () => mocks.activeTabPath,
  useCompilationResult: () => null,
  useCompilerSettings: () => mocks.compilerSettings,
  useCursorPosition: () => ({ line: 12, column: 8 }),
  useEditorTabs: () => mocks.editorTabs,
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
        'compiler.tinymist': 'Tinymist',
        'compiler.typstCli': 'Typst CLI',
        'compiler.typstWasm': 'Typst',
        'compiler.latexProbing': 'Probing LaTeX engines',
        'compiler.typstProbing': 'Probing Typst engines',
        'compiler.latexNoEngine': 'No LaTeX engines detected',
        'compiler.typstNoEngine': 'No Typst engines detected',
        'statusBar.typstCompiler': 'Typst compiler',
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
    mocks.updateCompiler.mockClear();
    mocks.compilerSettings.engine = 'xelatex';
    mocks.compilerSettings.typstEngine = 'tinymist';
    mocks.activeTabPath = 'D:/paper/main.tex';
    mocks.editorTabs = [{ path: 'D:/paper/main.tex', name: 'main.tex' }];
    mocks.getLaTeXCapabilities.mockResolvedValue({
      cli: {
        pdflatex: { available: true, version: 'pdfTeX 1.40' },
        xelatex: { available: true, version: 'XeTeX 0.999' },
        lualatex: { available: true, version: 'LuaHBTeX 1.18' },
        tectonic: { available: true, version: 'tectonic 0.15' },
      },
      wasm: {
        pdftex: { available: true, version: null },
        xetex: { available: true, version: null },
        lualatex: { available: true, version: null },
      },
    });
    mocks.getTypstCapabilities.mockResolvedValue({
      cli: {
        tinymist: { available: true, version: 'tinymist 0.13' },
        typst: { available: true, version: 'typst 0.13' },
      },
      wasm: { available: true, version: '0.6.0' },
    });
  });

  it('exposes the compiler selector as an accessible expandable control', async () => {
    render(<StatusBar />);

    const selector = screen.getByRole('button', { name: 'Select compile engine' });
    expect(selector).toHaveAttribute('aria-expanded', 'false');
    expect(selector).toHaveAttribute('aria-haspopup', 'menu');
    expect(selector).toHaveClass('focus-visible:ring-1');

    fireEvent.click(selector);

    expect(selector).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    expect(selector).toHaveAttribute('aria-controls', menu.id);
    const luaLatex = await screen.findByRole('menuitemradio', { name: 'LuaLaTeX' });
    expect(luaLatex).toHaveClass('cursor-pointer');
    expect(screen.getByRole('menuitemradio', { name: 'LuaLaTeX' })).toHaveClass(
      'focus-visible:ring-1'
    );
  });

  it('updates the compiler and closes the menu when an engine is picked', async () => {
    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'LuaLaTeX' }));

    expect(mocks.updateCompiler).toHaveBeenCalledWith({ engine: 'lualatex' });
    expect(screen.queryByRole('menuitemradio', { name: 'LuaLaTeX' })).not.toBeInTheDocument();
  });

  it('moves focus into the compiler menu and restores it when Escape closes', async () => {
    render(<StatusBar />);

    const selector = screen.getByRole('button', { name: 'Select compile engine' });
    selector.focus();
    fireEvent.click(selector);

    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    expect(await screen.findByRole('menuitemradio', { name: 'XeLaTeX' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: 'Local compiler' })).not.toBeInTheDocument();
    expect(selector).toHaveFocus();
  });

  it('supports arrow-key navigation inside the compiler menu', async () => {
    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));

    const menu = screen.getByRole('menu', { name: 'Local compiler' });
    const xelatex = await screen.findByRole('menuitemradio', { name: 'XeLaTeX' });
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

  it('hides unavailable LaTeX engines from the compiler menu', async () => {
    mocks.getLaTeXCapabilities.mockResolvedValueOnce({
      cli: {
        pdflatex: { available: true, version: 'pdfTeX 1.40' },
        xelatex: { available: false, version: null },
        lualatex: { available: false, version: null },
        tectonic: { available: false, version: null },
      },
      wasm: {
        pdftex: { available: true, version: null },
        xetex: { available: true, version: null },
        lualatex: { available: true, version: null },
      },
    });

    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));

    await waitFor(() => {
      expect(screen.getByRole('menuitemradio', { name: 'pdfLaTeX' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('menuitemradio', { name: 'XeLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'LuaLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Tectonic' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'WASM XeTeX' })).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.updateCompiler).toHaveBeenCalledWith({ engine: 'pdflatex' });
    });
  });

  it('does not show stale LaTeX engines while capability probing is pending', () => {
    mocks.getLaTeXCapabilities.mockReturnValueOnce(new Promise(() => undefined));
    mocks.getTypstCapabilities.mockReturnValueOnce(new Promise(() => undefined));

    render(<StatusBar />);

    expect(screen.getByText('Probing LaTeX engines')).toBeInTheDocument();
    expect(screen.queryByText('XeLaTeX')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));

    expect(screen.getAllByText('Probing LaTeX engines')).toHaveLength(2);
    expect(screen.queryByRole('menuitemradio', { name: 'XeLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'LuaLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'pdfLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Tectonic' })).not.toBeInTheDocument();
  });

  it('hides unavailable Typst engines from the compiler menu', async () => {
    mocks.activeTabPath = 'D:/paper/main.typ';
    mocks.editorTabs = [{ path: 'D:/paper/main.typ', name: 'main.typ' }];
    mocks.getTypstCapabilities.mockResolvedValueOnce({
      cli: {
        tinymist: { available: false, version: null },
        typst: { available: true, version: 'typst 0.13' },
      },
      wasm: { available: false, version: null },
    });

    render(<StatusBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Select compile engine' }));

    await waitFor(() => {
      expect(screen.getByRole('menuitemradio', { name: 'Typst CLI' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('menuitemradio', { name: 'Tinymist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Typst' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.updateCompiler).toHaveBeenCalledWith({ typstEngine: 'typst' });
    });
  });
});
