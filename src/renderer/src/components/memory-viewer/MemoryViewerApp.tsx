/**
 * @file MemoryViewerApp.tsx — secondary-window root for Memory / Skills viewer.
 *
 * Mounted at the URL hash `#/memory-viewer`. Lives in the same renderer
 * bundle as the main App so we don't ship a second build target. Holds
 * the tab shell only; pane bodies are in `MemoryPane` / `SkillsPane`.
 *
 * The viewer assumes a SNACA session has already been opened by the main
 * window. The handlers in main return a "no active session" error
 * otherwise and the panes surface it as an empty state.
 */

import { Brain } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from '../../locales';
import { MemoryPane } from './MemoryPane';
import { SkillsPane } from './SkillsPane';

function parseInitialTab(): 'memory' | 'skills' {
  const match = window.location.hash.match(/[?&]tab=(memory|skills)/);
  return (match?.[1] as 'memory' | 'skills') ?? 'memory';
}

export const MemoryViewerApp: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'memory' | 'skills'>(parseInitialTab);

  return (
    <div
      className="flex h-screen flex-col"
      style={{ background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}
    >
      <header
        className="flex h-12 shrink-0 items-center gap-4 border-b px-4"
        style={{ borderBottomColor: 'var(--color-border)' }}
      >
        <Brain size={18} />
        <h1 className="text-sm font-semibold">{t('memoryViewer.title')}</h1>
        <div className="ml-4 flex gap-1">
          {(['memory', 'skills'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded px-3 py-1 text-xs ${
                activeTab === tab
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {t(tab === 'memory' ? 'memoryViewer.tabMemory' : 'memoryViewer.tabSkills')}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {activeTab === 'memory' ? <MemoryPane /> : <SkillsPane />}
      </main>
    </div>
  );
};
