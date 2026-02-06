/**
 * @file StatusBar.tsx - Status Bar Component
 * @description Displays editor status, cursor position, sync status and system info
 * @depends api, services/core, RunOnceScheduler
 */

import {
  BookOpen,
  Check,
  ChevronUp,
  Cloud,
  Cpu,
  FolderSync,
  HardDrive,
  Save,
  X,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RunOnceScheduler } from '../../../../../shared/utils';
import { api } from '../../api';
import logoS from '../../assets/logo-s.svg';
import { useClickOutside, useEvent } from '../../hooks';
import {
  getEditorService,
  getProjectService,
  getSettingsService,
} from '../../services/core/ServiceRegistry';
import {
  useActiveTabPath,
  useCompilerSettings,
  useCompletionKnowledgeBaseId,
  useCursorPosition,
  useEditorTabs,
  useKnowledgeBases,
  useProjectPath,
} from '../../services/core/hooks';
import { useTranslation } from '../../locales';
import type { LaTeXEngine, OverleafCompiler } from '../../types';

export const StatusBar: React.FC = () => {
  const { t } = useTranslation();
  const projectPath = useProjectPath();
  const knowledgeBases = useKnowledgeBases();
  const completionKnowledgeBaseId = useCompletionKnowledgeBaseId();
  const activeTabPath = useActiveTabPath();
  const openTabs = useEditorTabs();
  const cursorPosition = useCursorPosition();
  const compilerSettings = useCompilerSettings();

  const activeTab = openTabs.find((tab) => tab.path === activeTabPath);
  const isTypstFile = activeTab?.name?.endsWith('.typ') || false;

  const [isKBDropdownOpen, setIsKBDropdownOpen] = useState(false);
  const [isEngineDropdownOpen, setIsEngineDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const engineDropdownRef = useRef<HTMLDivElement>(null);

  // ====== Save Status ======

  // Why: RunOnceScheduler prevents flicker on rapid saves by resetting timer on each save
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  // ====== Local Replica State ======

  const [isLocalReplicaWatching, setIsLocalReplicaWatching] = useState(false);
  const [hasLocalReplica, setHasLocalReplica] = useState(false);

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

  useClickOutside(dropdownRef, () => setIsKBDropdownOpen(false), isKBDropdownOpen);
  useClickOutside(engineDropdownRef, () => setIsEngineDropdownOpen(false), isEngineDropdownOpen);

  // ====== Knowledge Base Loading ======

  useEffect(() => {
    let retryCount = 0;
    const maxRetries = 5;
    const retryDelay = 1000;

    const loadKnowledgeBases = async (): Promise<boolean> => {
      try {
        const libs = await api.knowledge.getLibraries();
        if (libs && libs.length > 0) {
          const kbs = libs.map((lib) => ({
            id: lib.id,
            name: lib.name,
            description: lib.description,
            documentCount: lib.documentCount || 0,
            createdAt: lib.createdAt,
            updatedAt: lib.updatedAt,
          }));
          getProjectService().setKnowledgeBases(kbs);
          return kbs.length > 0;
        }
        return false;
      } catch (error) {
        // Why: Startup race conditions may occur before IPC handlers are registered
        const isStartupRace =
          error instanceof Error &&
          (error.message.includes('No handler registered') ||
            error.message.includes('not initialized'));
        if (!isStartupRace) {
          console.error('[StatusBar] Failed to load knowledge bases:', error);
        }
        return false;
      }
    };

    const tryLoad = async () => {
      const success = await loadKnowledgeBases();
      if (!success && retryCount < maxRetries - 1) {
        retryCount++;
        setTimeout(tryLoad, retryDelay);
      }
    };

    if (knowledgeBases.length === 0) {
      setTimeout(tryLoad, 500);
    }
  }, [knowledgeBases.length]);

  const selectedKB = knowledgeBases.find((kb) => kb.id === completionKnowledgeBaseId);

  const isRemoteProject =
    projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');

  // ====== Local Replica Status ======

  useEffect(() => {
    if (!isRemoteProject) {
      setHasLocalReplica(false);
      setIsLocalReplicaWatching(false);
      return;
    }

    const checkLocalReplica = async () => {
      try {
        const config = await api.localReplica.getConfig();
        setHasLocalReplica(!!config);
        if (config) {
          const watching = await api.localReplica.isWatching();
          setIsLocalReplicaWatching(watching);
        }
      } catch {
        setHasLocalReplica(false);
        setIsLocalReplicaWatching(false);
      }
    };

    checkLocalReplica();
    const interval = setInterval(checkLocalReplica, 5000);
    return () => clearInterval(interval);
  }, [isRemoteProject]);

  // ====== Helpers ======

  const getProjectName = () => {
    if (!projectPath) return '';
    if (isRemoteProject) {
      const fileTree = getProjectService().fileTree;
      return fileTree?.name || projectPath.split('/').pop() || 'Remote Project';
    }
    return projectPath.split(/[/\\]/).pop() || '';
  };

  const getCurrentFileName = () => {
    if (!activeTabPath) return '';
    return activeTabPath.split(/[/\\]/).pop() || '';
  };

  const getLanguageType = () => {
    const fileName = getCurrentFileName();
    if (fileName.endsWith('.tex') || fileName.endsWith('.latex')) return 'LaTeX';
    if (fileName.endsWith('.bib')) return 'BibTeX';
    if (fileName.endsWith('.sty') || fileName.endsWith('.cls')) return 'LaTeX Style';
    if (fileName.endsWith('.md')) return 'Markdown';
    if (fileName.endsWith('.json')) return 'JSON';
    if (fileName.endsWith('.txt')) return 'Plain Text';
    if (fileName.endsWith('.py')) return 'Python';
    if (fileName.endsWith('.js') || fileName.endsWith('.ts')) return 'JavaScript';
    return 'LaTeX';
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

        {/* Project Status (Remote/Local) */}
        <div
          className="flex items-center gap-1.5 px-3 h-full flex-shrink-0"
          style={{ borderRight: '1px solid var(--color-border-subtle)' }}
        >
          {isRemoteProject ? (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
              <Cloud className="w-3.5 h-3.5 text-[var(--color-success)] flex-shrink-0" />
              <span className="text-[var(--color-success)] hidden sm:inline font-medium">
                {t('statusBar.cloud')}
              </span>
            </>
          ) : (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              <HardDrive className="w-3.5 h-3.5 text-[var(--color-accent)] flex-shrink-0" />
              <span className="text-[var(--color-accent)] hidden sm:inline font-medium">
                {t('statusBar.local')}
              </span>
            </>
          )}
        </div>

        {/* Local Replica Sync Status (Remote projects only) */}
        {isRemoteProject && hasLocalReplica && (
          <div
            className="flex items-center gap-1.5 px-3 h-full flex-shrink-0"
            style={{ borderRight: '1px solid var(--color-border-subtle)' }}
            title={
              isLocalReplicaWatching
                ? t('statusBar.localReplicaAutoSyncing')
                : t('statusBar.localReplicaConfigured')
            }
          >
            {isLocalReplicaWatching ? (
              <>
                <FolderSync className="w-3.5 h-3.5 text-[var(--color-success)] flex-shrink-0" />
                <span className="text-[var(--color-success)] hidden lg:inline text-[11px]">
                  {t('statusBar.syncing')}
                </span>
              </>
            ) : (
              <>
                <FolderSync className="w-3.5 h-3.5 text-[var(--color-text-muted)] flex-shrink-0" />
                <span className="text-[var(--color-text-muted)] hidden lg:inline text-[11px]">
                  {t('statusBar.replica')}
                </span>
              </>
            )}
          </div>
        )}

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
            <Save size={12} />
            <span className="hidden sm:inline">{t('statusBar.saved')}</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0" />

      {/* Right - Compile Status and Tools */}
      <div className="flex items-center h-full flex-shrink-0 relative z-10">
        {/* Knowledge Base Selector */}
        <div
          className="relative h-full"
          ref={dropdownRef}
          style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
        >
          <button
            onClick={() => setIsKBDropdownOpen(!isKBDropdownOpen)}
            className="flex items-center gap-1.5 px-3 h-full transition-all cursor-pointer"
            style={{
              color: selectedKB ? 'var(--color-success)' : 'var(--color-text-muted)',
              background: isKBDropdownOpen ? 'var(--color-bg-hover)' : 'transparent',
            }}
            title={
              selectedKB
                ? t('statusBar.completionKB', { name: selectedKB.name })
                : t('statusBar.selectCompletionKB')
            }
          >
            <BookOpen size={13} className="flex-shrink-0" />
            <span className="max-w-[70px] truncate hidden sm:inline text-[11px] font-medium">
              {selectedKB ? selectedKB.name : t('statusBar.noKB')}
            </span>
            <ChevronUp
              size={11}
              className={`transition-transform flex-shrink-0 ${isKBDropdownOpen ? '' : 'rotate-180'}`}
            />
          </button>

          {isKBDropdownOpen && (
            <div
              className="absolute bottom-full right-0 mb-1 w-60 rounded-xl py-1.5 z-50"
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
                {t('statusBar.completionKnowledgeBase')}
              </div>

              <button
                onClick={() => {
                  getProjectService().setCompletionKnowledgeBase(null);
                  setIsKBDropdownOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-xs flex items-center justify-between transition-colors cursor-pointer"
                style={{
                  color: !completionKnowledgeBaseId
                    ? 'var(--color-success)'
                    : 'var(--color-text-secondary)',
                  background: !completionKnowledgeBaseId
                    ? 'var(--color-success-muted)'
                    : 'transparent',
                }}
              >
                <span className="flex items-center gap-2">
                  <X size={12} />
                  {t('statusBar.noKnowledgeBase')}
                </span>
                {!completionKnowledgeBaseId && <Check size={12} />}
              </button>

              {knowledgeBases.length > 0 ? (
                <div className="max-h-48 overflow-y-auto">
                  {knowledgeBases.map((kb) => (
                    <button
                      key={kb.id}
                      onClick={() => {
                        getProjectService().setCompletionKnowledgeBase(kb.id);
                        setIsKBDropdownOpen(false);
                      }}
                      className="w-full px-3 py-2 text-left text-xs flex items-center justify-between transition-colors cursor-pointer"
                      style={{
                        color:
                          completionKnowledgeBaseId === kb.id
                            ? 'var(--color-success)'
                            : 'var(--color-text-secondary)',
                        background:
                          completionKnowledgeBaseId === kb.id
                            ? 'var(--color-success-muted)'
                            : 'transparent',
                      }}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <BookOpen size={12} />
                        <span className="truncate">{kb.name}</span>
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          ({kb.documentCount})
                        </span>
                      </span>
                      {completionKnowledgeBaseId === kb.id && <Check size={12} />}
                    </button>
                  ))}
                </div>
              ) : (
                <div
                  className="px-3 py-3 text-xs text-center"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {t('statusBar.noKnowledgeBases')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Compile Engine Selector */}
        <div
          className="relative h-full"
          ref={engineDropdownRef}
          style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
        >
          <button
            onClick={() => setIsEngineDropdownOpen(!isEngineDropdownOpen)}
            className="flex items-center gap-1.5 px-3 h-full transition-all cursor-pointer"
            style={{
              color: isTypstFile ? '#a855f7' : 'var(--color-warning)',
              background: isEngineDropdownOpen ? 'var(--color-bg-hover)' : 'transparent',
            }}
            title={t('statusBar.selectCompileEngine')}
          >
            <Cpu size={13} className="flex-shrink-0" />
            <span className="max-w-[80px] truncate text-[11px] font-mono font-medium">
              {isRemoteProject
                ? (compilerSettings.overleaf?.remoteCompiler || 'pdflatex').toUpperCase()
                : isTypstFile
                  ? (compilerSettings.typstEngine || 'tinymist').toUpperCase()
                  : compilerSettings.engine.toUpperCase()}
            </span>
            <ChevronUp
              size={11}
              className={`transition-transform flex-shrink-0 ${isEngineDropdownOpen ? '' : 'rotate-180'}`}
            />
          </button>

          {isEngineDropdownOpen && (
            <div
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
                {isRemoteProject ? t('statusBar.remoteCompiler') : t('statusBar.localCompiler')}
              </div>

              {isRemoteProject ? (
                <>
                  {[
                    {
                      value: 'pdflatex',
                      label: 'pdfLaTeX',
                      descKey: 'statusBar.fastEnglishOnly' as const,
                    },
                    {
                      value: 'latex',
                      label: 'LaTeX',
                      descKey: 'statusBar.traditionalLatex' as const,
                    },
                    {
                      value: 'xelatex',
                      label: 'XeLaTeX',
                      descKey: 'statusBar.unicodeSupport' as const,
                    },
                    {
                      value: 'lualatex',
                      label: 'LuaLaTeX',
                      descKey: 'statusBar.unicodeAndLua' as const,
                    },
                  ].map((engine) => (
                    <button
                      key={engine.value}
                      onClick={async () => {
                        getSettingsService().updateCompiler({
                          overleaf: {
                            ...compilerSettings.overleaf,
                            remoteCompiler: engine.value as OverleafCompiler,
                          },
                        });
                        setIsEngineDropdownOpen(false);
                        const projectId = compilerSettings.overleaf?.projectId;
                        if (projectId) {
                          await api.overleaf.updateSettings(projectId, {
                            compiler: engine.value,
                          });
                        }
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-hover)] flex items-center justify-between ${
                        compilerSettings.overleaf?.remoteCompiler === engine.value
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span className="flex flex-col">
                        <span>{engine.label}</span>
                        <span className="text-[var(--color-text-muted)] text-[10px]">
                          {t(engine.descKey)}
                        </span>
                      </span>
                      {compilerSettings.overleaf?.remoteCompiler === engine.value && (
                        <Check size={12} />
                      )}
                    </button>
                  ))}
                </>
              ) : isTypstFile ? (
                <>
                  <div className="px-3 py-1 text-xs text-purple-400 border-b border-editor-border">
                    {t('statusBar.typstCompiler')}
                  </div>
                  {[
                    {
                      value: 'tinymist',
                      label: 'Tinymist',
                      descKey: 'statusBar.recommendedFullFeatures' as const,
                    },
                    {
                      value: 'typst',
                      label: 'Typst CLI',
                      descKey: 'statusBar.officialCliTool' as const,
                    },
                  ].map((engine) => (
                    <button
                      key={engine.value}
                      onClick={() => {
                        getSettingsService().updateCompiler({
                          typstEngine: engine.value as 'typst' | 'tinymist',
                        });
                        setIsEngineDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-hover)] flex items-center justify-between ${
                        compilerSettings.typstEngine === engine.value
                          ? 'text-[var(--color-info)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span className="flex flex-col">
                        <span>{engine.label}</span>
                        <span className="text-[var(--color-text-muted)] text-[10px]">
                          {t(engine.descKey)}
                        </span>
                      </span>
                      {compilerSettings.typstEngine === engine.value && <Check size={12} />}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {[
                    {
                      value: 'xelatex',
                      label: 'XeLaTeX',
                      descKey: 'statusBar.recommendedUnicode' as const,
                    },
                    {
                      value: 'lualatex',
                      label: 'LuaLaTeX',
                      descKey: 'statusBar.unicodeAndLua' as const,
                    },
                    {
                      value: 'pdflatex',
                      label: 'pdfLaTeX',
                      descKey: 'statusBar.fastEnglishOnly' as const,
                    },
                    {
                      value: 'tectonic',
                      label: 'Tectonic',
                      descKey: 'statusBar.modernCompiler' as const,
                    },
                  ].map((engine) => (
                    <button
                      key={engine.value}
                      onClick={() => {
                        getSettingsService().updateCompiler({
                          engine: engine.value as LaTeXEngine,
                        });
                        setIsEngineDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-hover)] flex items-center justify-between ${
                        compilerSettings.engine === engine.value
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span className="flex flex-col">
                        <span>{engine.label}</span>
                        <span className="text-[var(--color-text-muted)] text-[10px]">
                          {t(engine.descKey)}
                        </span>
                      </span>
                      {compilerSettings.engine === engine.value && <Check size={12} />}
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
