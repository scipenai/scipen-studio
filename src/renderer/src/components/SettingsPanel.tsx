/**
 * @file SettingsPanel.tsx - Settings Panel Container
 * @description General settings panel with editor, compiler, UI configuration tabs
 */

import { clsx } from 'clsx';
import { BookMarked, Brain, Code, FileText, Hand, Keyboard, Palette, RefreshCw, Sparkles } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../locales';
import type { TranslationKey } from '../locales';
import { getStorageService } from '../services/StorageService';
import {
  AITab,
  AgentTab,
  CompilerTab,
  EditorTab,
  SelectionTab,
  ShortcutsTab,
  UITab,
  UpdateTab,
  ZoteroTab,
} from './settings';

type SettingsTab =
  | 'editor'
  | 'compiler'
  | 'selection'
  | 'ui'
  | 'shortcuts'
  | 'ai'
  | 'agent'
  | 'zotero'
  | 'update';
const SETTINGS_PANEL_TAB_KEY = 'ui.settingsPanelTab';

const tabs: {
  id: SettingsTab;
  labelKey: TranslationKey;
  icon: React.ReactNode;
  summaryKey: TranslationKey;
}[] = [
  {
    id: 'ai',
    labelKey: 'settings.tabs.ai',
    icon: <Sparkles size={14} />,
    summaryKey: 'settingsPanel.summaries.ai',
  },
  {
    id: 'agent',
    labelKey: 'settings.tabs.agent',
    icon: <Brain size={14} />,
    summaryKey: 'settingsPanel.summaries.agent',
  },
  {
    id: 'compiler',
    labelKey: 'settings.tabs.compiler',
    icon: <FileText size={14} />,
    summaryKey: 'settingsPanel.summaries.compiler',
  },
  {
    id: 'editor',
    labelKey: 'settings.tabs.editor',
    icon: <Code size={14} />,
    summaryKey: 'settingsPanel.summaries.editor',
  },
  {
    id: 'ui',
    labelKey: 'settings.tabs.ui',
    icon: <Palette size={14} />,
    summaryKey: 'settingsPanel.summaries.ui',
  },
  {
    id: 'shortcuts',
    labelKey: 'settings.tabs.shortcuts',
    icon: <Keyboard size={14} />,
    summaryKey: 'settingsPanel.summaries.shortcuts',
  },
  {
    id: 'selection',
    labelKey: 'settings.tabs.selection',
    icon: <Hand size={14} />,
    summaryKey: 'settingsPanel.summaries.selection',
  },
  {
    id: 'zotero',
    labelKey: 'settings.tabs.zotero',
    icon: <BookMarked size={14} />,
    summaryKey: 'settingsPanel.summaries.zotero',
  },
  {
    id: 'update',
    labelKey: 'settings.tabs.update',
    icon: <RefreshCw size={14} />,
    summaryKey: 'settingsPanel.summaries.update',
  },
];

const TabContent: React.FC<{ activeTab: SettingsTab }> = ({ activeTab }) => {
  switch (activeTab) {
    case 'editor':
      return <EditorTab />;
    case 'compiler':
      return <CompilerTab />;
    case 'selection':
      return <SelectionTab />;
    case 'ui':
      return <UITab />;
    case 'shortcuts':
      return <ShortcutsTab />;
    case 'ai':
      return <AITab />;
    case 'agent':
      return <AgentTab />;
    case 'zotero':
      return <ZoteroTab />;
    case 'update':
      return <UpdateTab />;
    default:
      return null;
  }
};

export const SettingsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const storedTab = getStorageService().getString(SETTINGS_PANEL_TAB_KEY, 'ai') as SettingsTab;
    return tabs.some((tab) => tab.id === storedTab) ? storedTab : 'ai';
  });
  const { t } = useTranslation();

  const activeMeta = useMemo(
    () => tabs.find((tab) => tab.id === activeTab) ?? tabs[0],
    [activeTab]
  );

  useEffect(() => {
    getStorageService().store(SETTINGS_PANEL_TAB_KEY, activeTab);
  }, [activeTab]);

  return (
    <div className="flex h-full min-h-0" style={{ background: 'var(--color-bg-secondary)' }}>
      <div
        className="flex w-[176px] flex-col border-r"
        style={{
          borderRightColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-primary) 94%, transparent)',
        }}
      >
        <div
          className="border-b px-4 py-4"
          style={{ borderBottomColor: 'var(--color-border-subtle)' }}
        >
          <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            {t('settingsPanel.title')}
          </div>
          <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
            {t('settingsPanel.description')}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                activeTab === tab.id
                  ? 'bg-[var(--color-accent)] text-white shadow-[0_8px_18px_rgba(15,157,223,0.18)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              )}
              style={activeTab === tab.id ? undefined : { background: 'transparent' }}
              onMouseEnter={(event) => {
                if (activeTab === tab.id) return;
                event.currentTarget.style.background = 'var(--color-bg-hover)';
              }}
              onMouseLeave={(event) => {
                if (activeTab === tab.id) return;
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <span className="flex h-4 w-4 items-center justify-center">{tab.icon}</span>
              <span className="truncate">{t(tab.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className="border-b px-5 py-4"
          style={{
            borderBottomColor: 'var(--color-border-subtle)',
            background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
          }}
        >
          <div className="text-[15px] font-semibold text-[var(--color-text-primary)]">
            {t(activeMeta.labelKey)}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-muted)]">
            {t(activeMeta.summaryKey)}
          </div>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          <TabContent activeTab={activeTab} />
        </div>
      </div>
    </div>
  );
};
