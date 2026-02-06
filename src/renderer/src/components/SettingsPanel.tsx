/**
 * @file SettingsPanel.tsx - Settings Panel Container
 * @description General settings panel with editor, compiler, UI configuration tabs
 */

import { clsx } from 'clsx';
import { Code, Database, FileText, Hand, Keyboard, Palette, Wrench } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';

import { useTranslation } from '../locales';
import type { TranslationKey } from '../locales';
import {
  AgentsTab,
  CompilerTab,
  EditorTab,
  RAGTab,
  SelectionTab,
  ShortcutsTab,
  UITab,
} from './settings';

type SettingsTab = 'editor' | 'compiler' | 'rag' | 'agents' | 'selection' | 'ui' | 'shortcuts';

const tabs: { id: SettingsTab; labelKey: TranslationKey; icon: React.ReactNode }[] = [
  { id: 'editor', labelKey: 'settings.tabs.editor', icon: <Code size={14} /> },
  { id: 'compiler', labelKey: 'settings.tabs.compiler', icon: <FileText size={14} /> },
  { id: 'rag', labelKey: 'settings.tabs.rag', icon: <Database size={14} /> },
  { id: 'agents', labelKey: 'settings.tabs.agents', icon: <Wrench size={14} /> },
  { id: 'selection', labelKey: 'settings.tabs.selection', icon: <Hand size={14} /> },
  { id: 'ui', labelKey: 'settings.tabs.ui', icon: <Palette size={14} /> },
  { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', icon: <Keyboard size={14} /> },
];

const TabContent: React.FC<{ activeTab: SettingsTab }> = ({ activeTab }) => {
  switch (activeTab) {
    case 'editor':
      return <EditorTab />;
    case 'compiler':
      return <CompilerTab />;
    case 'rag':
      return <RAGTab />;
    case 'agents':
      return <AgentsTab />;
    case 'selection':
      return <SelectionTab />;
    case 'ui':
      return <UITab />;
    case 'shortcuts':
      return <ShortcutsTab />;
    default:
      return null;
  }
};

export const SettingsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('editor');
  const { t } = useTranslation();

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      <div className="flex flex-wrap border-b border-[var(--color-border-subtle)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-all cursor-pointer',
              'border-b-2 -mb-px',
              activeTab === tab.id
                ? 'text-[var(--color-text-primary)] border-[var(--color-accent)] bg-[var(--color-bg-tertiary)]/50'
                : 'text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]/50'
            )}
          >
            {tab.icon}
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <TabContent activeTab={activeTab} />
      </div>
    </div>
  );
};
