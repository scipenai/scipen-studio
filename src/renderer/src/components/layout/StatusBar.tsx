/**
 * @file StatusBar.tsx - Status Bar Component
 * @description Displays editor status, cursor position, sync status and system info
 * @depends api, services/core, RunOnceScheduler
 */

import { AlertTriangle, Check, ChevronUp, Cpu, HardDrive, Save } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  LaTeXCapabilities,
  TypstCapabilities,
} from '../../../../../shared/ipc/compile-contract';
import { RunOnceScheduler } from '../../../../../shared/utils';
import logoS from '../../assets/logo-s.svg';
import { api } from '../../api';
import { useClickOutside, useEvent } from '../../hooks';
import { getLanguageForFile } from '../../utils';
import { AgentStatusSegment } from './AgentStatusSegment';
import { ZoteroStatusBadge } from './ZoteroStatusBadge';
import { ActiveRecommendationSegment } from './ActiveRecommendationSegment';
import { getEditorService, getSettingsService } from '../../services/core/ServiceRegistry';
import {
  useActiveTabPath,
  useCompilationResult,
  useCompilerSettings,
  useCursorPosition,
  useEditorTabs,
  useProjectPath,
} from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import type { LaTeXEngine, TypstEngine } from '../../types';

type CompileEngineOption = {
  value: LaTeXEngine | TypstEngine;
  label: string;
};

function unavailableLatexCaps(): LaTeXCapabilities {
  const unavailable = { available: false, version: null };
  return {
    cli: {
      pdflatex: { ...unavailable },
      xelatex: { ...unavailable },
      lualatex: { ...unavailable },
      tectonic: { ...unavailable },
    },
    wasm: {
      pdftex: { ...unavailable },
      xetex: { ...unavailable },
      lualatex: { ...unavailable },
    },
  };
}

function unavailableTypstCaps(): TypstCapabilities {
  const unavailable = { available: false, version: null };
  return {
    cli: {
      tinymist: { ...unavailable },
      typst: { ...unavailable },
    },
    wasm: { ...unavailable },
  };
}

export const StatusBar: React.FC = () => {
  const { t } = useTranslation();
  const projectPath = useProjectPath();
  const activeTabPath = useActiveTabPath();
  const compilationResult = useCompilationResult();
  const openTabs = useEditorTabs();
  const cursorPosition = useCursorPosition();
  const compilerSettings = useCompilerSettings();

  const activeTab = openTabs.find((tab) => tab.path === activeTabPath);
  const isTypstFile = activeTab?.name?.endsWith('.typ') || false;

  const [isEngineDropdownOpen, setIsEngineDropdownOpen] = useState(false);
  const [latexCaps, setLatexCaps] = useState<LaTeXCapabilities | null>(null);
  const [typstCaps, setTypstCaps] = useState<TypstCapabilities | null>(null);
  const engineDropdownRef = useRef<HTMLDivElement>(null);
  const engineMenuRef = useRef<HTMLDivElement>(null);
  const engineMenuId = useId();
  const previouslyFocusedEngineRef = useRef<HTMLElement | null>(null);

  // ====== Save Status ======

  // RunOnceScheduler resets its timer on each save to suppress flicker during rapid saves.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  const hideStatusScheduler = useMemo(
    () =>
      new RunOnceScheduler(() => {
        setSaveStatus('idle');
      }, 3000),
    []
  );

  useEffect(() => {
    return () => hideStatusScheduler.dispose();
  }, [hideStatusScheduler]);

  useEvent(getEditorService().onDidMarkClean, () => {
    setSaveStatus('saved');
    hideStatusScheduler.schedule();
  });

  useEffect(() => {
    let cancelled = false;

    api.compile
      .getLaTeXCapabilities()
      .then((caps) => {
        if (!cancelled) setLatexCaps(caps);
      })
      .catch(() => {
        if (!cancelled) setLatexCaps(unavailableLatexCaps());
      });

    api.compile
      .getTypstCapabilities()
      .then((caps) => {
        if (!cancelled) setTypstCaps(caps);
      })
      .catch(() => {
        if (!cancelled) setTypstCaps(unavailableTypstCaps());
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useClickOutside(engineDropdownRef, () => setIsEngineDropdownOpen(false), isEngineDropdownOpen);

  useEffect(() => {
    if (!isEngineDropdownOpen) return;

    previouslyFocusedEngineRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const selectedItem =
      engineMenuRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]') ?? null;
    const firstItem =
      engineMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]') ?? null;

    (selectedItem ?? firstItem ?? engineMenuRef.current)?.focus();

    return () => {
      previouslyFocusedEngineRef.current?.focus();
    };
  }, [isEngineDropdownOpen]);

  const getEngineMenuItems = (): HTMLButtonElement[] =>
    Array.from(
      engineMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []
    );

  const focusEngineMenuItem = (offset: number): void => {
    const items = getEngineMenuItems();
    if (items.length === 0) return;

    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + offset + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const handleEngineMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        focusEngineMenuItem(1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        focusEngineMenuItem(-1);
        break;
      case 'Home':
        event.preventDefault();
        getEngineMenuItems()[0]?.focus();
        break;
      case 'End': {
        event.preventDefault();
        const items = getEngineMenuItems();
        items[items.length - 1]?.focus();
        break;
      }
      case 'Enter':
      case ' ':
        if (document.activeElement instanceof HTMLButtonElement) {
          event.preventDefault();
          document.activeElement.click();
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        setIsEngineDropdownOpen(false);
        break;
      default:
        break;
    }
  };

  // ====== Helpers ======

  const getProjectName = () => {
    if (!projectPath) return '';
    return projectPath.split(/[/\\]/).pop() || '';
  };

  const getCurrentFileName = () => {
    if (!activeTabPath) return '';
    return activeTabPath.split(/[/\\]/).pop() || '';
  };

  const getCompilerLabel = useCallback(
    (engine: string): string => {
      switch (engine) {
        case 'pdflatex':
          return t('compiler.pdflatex');
        case 'xelatex':
          return t('compiler.xelatexRecommended');
        case 'lualatex':
          return t('compiler.lualatex');
        case 'tectonic':
          return t('compiler.tectonic');
        case 'wasm-pdftex':
          return t('compiler.wasmPdftex');
        case 'wasm-xetex':
          return t('compiler.wasmXetex');
        case 'wasm-lualatex':
          return t('compiler.wasmLualatex');
        case 'latex':
          return 'LaTeX';
        case 'tinymist':
          return t('compiler.tinymist');
        case 'typst':
          return t('compiler.typstCli');
        case 'wasm-typst':
          return t('compiler.typstWasm');
        default:
          return engine;
      }
    },
    [t]
  );

  const latexEngineOptions = useMemo<CompileEngineOption[]>(() => {
    if (!latexCaps) {
      return [
        { value: 'xelatex', label: getCompilerLabel('xelatex') },
        { value: 'lualatex', label: getCompilerLabel('lualatex') },
        { value: 'pdflatex', label: getCompilerLabel('pdflatex') },
        { value: 'tectonic', label: getCompilerLabel('tectonic') },
        { value: 'wasm-xetex', label: getCompilerLabel('wasm-xetex') },
        { value: 'wasm-pdftex', label: getCompilerLabel('wasm-pdftex') },
        { value: 'wasm-lualatex', label: getCompilerLabel('wasm-lualatex') },
      ];
    }

    const options: CompileEngineOption[] = [];
    if (latexCaps.cli.xelatex.available) {
      options.push({ value: 'xelatex', label: getCompilerLabel('xelatex') });
    }
    if (latexCaps.cli.lualatex.available) {
      options.push({ value: 'lualatex', label: getCompilerLabel('lualatex') });
    }
    if (latexCaps.cli.pdflatex.available) {
      options.push({ value: 'pdflatex', label: getCompilerLabel('pdflatex') });
    }
    if (latexCaps.cli.tectonic.available) {
      options.push({ value: 'tectonic', label: getCompilerLabel('tectonic') });
    }
    if (latexCaps.wasm.xetex.available) {
      options.push({ value: 'wasm-xetex', label: getCompilerLabel('wasm-xetex') });
    }
    if (latexCaps.wasm.pdftex.available) {
      options.push({ value: 'wasm-pdftex', label: getCompilerLabel('wasm-pdftex') });
    }
    if (latexCaps.wasm.lualatex.available) {
      options.push({ value: 'wasm-lualatex', label: getCompilerLabel('wasm-lualatex') });
    }
    return options;
  }, [getCompilerLabel, latexCaps]);

  const typstEngineOptions = useMemo<CompileEngineOption[]>(() => {
    if (!typstCaps) {
      return [
        { value: 'tinymist', label: getCompilerLabel('tinymist') },
        { value: 'typst', label: getCompilerLabel('typst') },
        { value: 'wasm-typst', label: getCompilerLabel('wasm-typst') },
      ];
    }

    const options: CompileEngineOption[] = [];
    if (typstCaps.cli.tinymist.available) {
      options.push({ value: 'tinymist', label: getCompilerLabel('tinymist') });
    }
    if (typstCaps.cli.typst.available) {
      options.push({ value: 'typst', label: getCompilerLabel('typst') });
    }
    if (typstCaps.wasm.available) {
      options.push({ value: 'wasm-typst', label: getCompilerLabel('wasm-typst') });
    }
    return options;
  }, [getCompilerLabel, typstCaps]);

  useEffect(() => {
    if (!latexCaps || latexEngineOptions.length === 0) return;
    if (latexEngineOptions.some((engine) => engine.value === compilerSettings.engine)) return;

    const next = latexEngineOptions[0].value;
    getSettingsService().updateCompiler({ engine: next as LaTeXEngine });
  }, [compilerSettings.engine, latexCaps, latexEngineOptions]);

  useEffect(() => {
    if (!typstCaps || typstEngineOptions.length === 0) return;
    if (typstEngineOptions.some((engine) => engine.value === compilerSettings.typstEngine)) return;

    const next = typstEngineOptions[0].value;
    getSettingsService().updateCompiler({ typstEngine: next as TypstEngine });
  }, [compilerSettings.typstEngine, typstCaps, typstEngineOptions]);

  const getLanguageType = () => {
    const fileName = getCurrentFileName();
    switch (getLanguageForFile(fileName)) {
      case 'latex':
        return fileName.endsWith('.sty') || fileName.endsWith('.cls') ? 'LaTeX Style' : 'LaTeX';
      case 'bibtex':
        return 'BibTeX';
      case 'typst':
        return 'Typst';
      case 'markdown':
        return 'Markdown';
      case 'json':
        return 'JSON';
      case 'plaintext':
        return 'Plain Text';
      case 'python':
        return 'Python';
      case 'javascript':
        return 'JavaScript';
      case 'typescript':
        return 'TypeScript';
      default:
        return 'Plain Text';
    }
  };

  // ====== Render ======

  return (
    <div
      className="h-7 flex items-center text-xs select-none"
      style={{
        background: 'var(--color-bg-void)',
        borderTop: '1px solid var(--color-border-subtle)',
      }}
    >
      <div className="flex items-center h-full min-w-0 flex-shrink">
        <div
          className="flex items-center gap-1.5 px-3 h-full min-w-0 flex-shrink"
          style={{ borderRight: '1px solid var(--color-border-subtle)' }}
        >
          <span
            className="truncate max-w-[100px] font-medium"
            title={getProjectName()}
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {getProjectName()}
          </span>
          {activeTabPath && (
            <>
              <span style={{ color: 'var(--color-text-disabled)' }}>/</span>
              <span
                className="truncate max-w-[80px]"
                title={getCurrentFileName()}
                style={{ color: 'var(--color-text-muted)' }}
              >
                {getCurrentFileName()}
              </span>
            </>
          )}
        </div>

        {/* Project Status (Local) */}
        <div
          className="flex items-center gap-1.5 px-3 h-full flex-shrink-0"
          style={{ borderRight: '1px solid var(--color-border-subtle)' }}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
          <HardDrive size={13} className="text-[var(--color-accent)] flex-shrink-0" />
          <span className="text-[var(--color-accent)] hidden sm:inline font-medium">
            {t('statusBar.local')}
          </span>
        </div>

        {/* Cursor Position */}
        <div
          className="flex items-center gap-1 px-3 h-full flex-shrink-0"
          style={{
            borderRight: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          <span className="whitespace-nowrap font-mono text-[11px]">
            {t('statusBar.line')} {cursorPosition.line}, {t('statusBar.column')}{' '}
            {cursorPosition.column}
          </span>
        </div>

        {/* Encoding */}
        <div
          className="px-3 h-full hidden md:flex items-center flex-shrink-0 font-mono text-[11px]"
          style={{
            borderRight: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          UTF-8
        </div>

        {/* Save Status */}
        {saveStatus === 'saved' && (
          <div
            className="flex items-center gap-1.5 px-3 h-full flex-shrink-0 text-[11px] font-medium animate-in fade-in duration-200"
            style={{
              borderRight: '1px solid var(--color-border-subtle)',
              color: 'var(--color-success)',
            }}
          >
            <Save size={13} />
            <span className="hidden sm:inline">{t('statusBar.saved')}</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0" />

      {/* Right - Compile Status and Tools */}
      <div className="flex items-center h-full flex-shrink-0 relative z-10">
        {compilationResult && (
          <div
            className="flex items-center gap-1.5 px-3 h-full flex-shrink-0 text-[11px] font-medium"
            style={{
              borderLeft: '1px solid var(--color-border-subtle)',
              color: compilationResult.success ? 'var(--color-success)' : 'var(--color-error)',
            }}
          >
            {compilationResult.success ? <Check size={13} /> : <AlertTriangle size={13} />}
            <span className="hidden sm:inline">
              {compilationResult.success
                ? t('statusBar.compileSuccess')
                : t('statusBar.compileFailed')}
            </span>
            {compilationResult.time && (
              <span className="text-[var(--color-text-muted)]">
                {(compilationResult.time / 1000).toFixed(2)}s
              </span>
            )}
          </div>
        )}

        {/* Compile Engine Selector */}
        <div
          className="relative h-full"
          ref={engineDropdownRef}
          style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
        >
          <button
            type="button"
            onClick={() => setIsEngineDropdownOpen(!isEngineDropdownOpen)}
            className="flex h-full cursor-pointer items-center gap-1.5 px-3 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            style={{
              color: isTypstFile ? 'var(--color-info)' : 'var(--color-warning)',
              background: isEngineDropdownOpen ? 'var(--color-bg-hover)' : 'transparent',
            }}
            title={t('statusBar.selectCompileEngine')}
            aria-label={t('statusBar.selectCompileEngine')}
            aria-expanded={isEngineDropdownOpen}
            aria-haspopup="menu"
            aria-controls={isEngineDropdownOpen ? engineMenuId : undefined}
          >
            <Cpu size={13} className="flex-shrink-0" aria-hidden="true" />
            <span className="max-w-[80px] truncate text-[11px] font-mono font-medium">
              {isTypstFile
                ? getCompilerLabel(compilerSettings.typstEngine || 'tinymist')
                : getCompilerLabel(compilerSettings.engine)}
            </span>
            <ChevronUp
              size={11}
              aria-hidden="true"
              className={`transition-transform flex-shrink-0 ${isEngineDropdownOpen ? '' : 'rotate-180'}`}
            />
          </button>

          {isEngineDropdownOpen && (
            <div
              id={engineMenuId}
              ref={engineMenuRef}
              role="menu"
              aria-label={t('statusBar.localCompiler')}
              tabIndex={-1}
              onKeyDown={handleEngineMenuKeyDown}
              className="absolute bottom-full right-0 mb-1 w-52 rounded-xl py-1.5 z-50"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div
                className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider"
                style={{
                  color: 'var(--color-text-muted)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                }}
              >
                {t('statusBar.localCompiler')}
              </div>

              {isTypstFile ? (
                <>
                  <div className="px-3 py-1 text-xs text-[var(--color-info)] border-b border-editor-border">
                    {t('statusBar.typstCompiler')}
                  </div>
                  {typstEngineOptions.map((engine) => (
                    <button
                      type="button"
                      key={engine.value}
                      role="menuitemradio"
                      aria-checked={compilerSettings.typstEngine === engine.value}
                      data-selected={
                        compilerSettings.typstEngine === engine.value ? 'true' : undefined
                      }
                      onClick={() => {
                        getSettingsService().updateCompiler({
                          typstEngine: engine.value as TypstEngine,
                        });
                        setIsEngineDropdownOpen(false);
                      }}
                      className={`flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                        compilerSettings.typstEngine === engine.value
                          ? 'text-[var(--color-info)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span>{engine.label}</span>
                      {compilerSettings.typstEngine === engine.value && (
                        <Check size={12} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {latexEngineOptions.map((engine) => (
                    <button
                      type="button"
                      key={engine.value}
                      role="menuitemradio"
                      aria-checked={compilerSettings.engine === engine.value}
                      data-selected={compilerSettings.engine === engine.value ? 'true' : undefined}
                      onClick={() => {
                        getSettingsService().updateCompiler({
                          engine: engine.value as LaTeXEngine,
                        });
                        setIsEngineDropdownOpen(false);
                      }}
                      className={`flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                        compilerSettings.engine === engine.value
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span>{engine.label}</span>
                      {compilerSettings.engine === engine.value && (
                        <Check size={12} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Language Type */}
        <div
          className="px-3 h-full hidden lg:flex items-center flex-shrink-0 text-[11px] font-medium"
          style={{
            borderLeft: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          {getLanguageType()}
        </div>

        {/* SNACA agent status — current turn / tokens / stop */}
        <AgentStatusSegment />

        {/* Zotero canonical bib index status badge */}
        <ZoteroStatusBadge />

        {/* M3 ruler 5: active citation recommendation badge (Sparkles N + click to reveal top 3) */}
        <ActiveRecommendationSegment />

        {/* SciPen Studio Brand */}
        <div
          className="flex items-center gap-2 px-3 h-full flex-shrink-0"
          style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
        >
          <img src={logoS} alt="SciPen" className="w-3.5 h-3.5 flex-shrink-0" />
          <span
            className="hidden xl:inline whitespace-nowrap text-[11px] font-medium"
            style={{ color: 'var(--color-text-muted)' }}
          >
            SciPen Studio
          </span>
        </div>
      </div>
    </div>
  );
};
