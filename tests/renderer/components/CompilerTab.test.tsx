import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompilerTab } from '../../../src/renderer/src/components/settings/CompilerTab';

const mocks = vi.hoisted(() => ({
  updateCompiler: vi.fn(),
  getLaTeXCapabilities: vi.fn(),
  getTypstCapabilities: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    compile: {
      getLaTeXCapabilities: mocks.getLaTeXCapabilities,
      getTypstCapabilities: mocks.getTypstCapabilities,
    },
  },
}));

vi.mock('../../../src/renderer/src/services/LogService', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getSettingsService: () => ({
    updateCompiler: mocks.updateCompiler,
  }),
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useProjectPath: () => 'D:/paper',
  useSettings: () => ({
    compiler: {
      engine: 'xelatex',
      typstEngine: 'typst',
      texliveEndpoint: '',
      typstFontEndpoint: '',
    },
  }),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'compiler.title': 'Compiler',
        'compiler.localProject': 'Local project',
        'compiler.engine': 'LaTeX Engine',
        'compiler.engineDesc': 'Choose LaTeX engine',
        'compiler.xelatexRecommended': 'XeLaTeX',
        'compiler.lualatex': 'LuaLaTeX',
        'compiler.pdflatex': 'pdfLaTeX',
        'compiler.tectonic': 'Tectonic',
        'compiler.wasmPdftex': 'WASM pdfTeX',
        'compiler.wasmXetex': 'WASM XeTeX',
        'compiler.wasmLualatex': 'WASM LuaTeX',
        'compiler.texliveEndpoint': 'TeX Live endpoint',
        'compiler.texliveEndpointDesc': 'TeX Live CDN',
        'compiler.typstEngine': 'Typst Compiler',
        'compiler.typstEngineDesc': 'Choose Typst engine',
        'compiler.tinymist': 'Tinymist',
        'compiler.typstCli': 'Typst CLI',
        'compiler.typstWasm': 'Typst',
        'compiler.typstProbing': 'Probing Typst',
        'compiler.typstNoEngine': 'No Typst engine',
        'compiler.typstEngineMissing': `Missing ${params?.engine ?? ''}`,
        'compiler.typstFontEndpoint': 'Typst fonts',
        'compiler.typstFontEndpointDesc': 'Typst font endpoint',
        'compiler.syncTexTitle': 'SyncTeX',
        'compiler.syncTexLocalSupport': 'Local SyncTeX',
        'compiler.syncTexWasmSupport': 'WASM SyncTeX',
        'compiler.syncTexTypstSupport': 'Typst SyncTeX',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('CompilerTab', () => {
  beforeEach(() => {
    mocks.updateCompiler.mockClear();
    mocks.getLaTeXCapabilities.mockResolvedValue({
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
    mocks.getTypstCapabilities.mockResolvedValue({
      cli: {
        tinymist: { available: false, version: null },
        typst: { available: true, version: 'typst 0.13' },
      },
      wasm: { available: false, version: null },
    });
  });

  it('hides unavailable local LaTeX engines from compiler settings', async () => {
    render(<CompilerTab />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'pdfLaTeX' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('option', { name: 'XeLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'LuaLaTeX' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tectonic' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'WASM XeTeX' })).toBeInTheDocument();
  });
});
