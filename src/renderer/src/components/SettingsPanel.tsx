/**
 * @file SettingsPanel.tsx - Settings Panel Container
 * @description AI-first 分组导航的设置面板:左栏按功能域分组,右栏渲染当前 tab 内容
 */

import { clsx } from 'clsx';
import {
  BookMarked,
  Brain,
  Code,
  FileText,
  Hand,
  Keyboard,
  Palette,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
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

interface TabMeta {
  id: SettingsTab;
  labelKey: TranslationKey;
  icon: React.ReactNode;
  summaryKey: TranslationKey;
}

const SETTINGS_PANEL_TAB_KEY = 'ui.settingsPanelTab';

const TAB_META: Record<SettingsTab, TabMeta> = {
  ai: { id: 'ai', labelKey: 'settings.tabs.ai', icon: <Sparkles size={14} />, summaryKey: 'settingsPanel.summaries.ai' },
  agent: { id: 'agent', labelKey: 'settings.tabs.agent', icon: <Brain size={14} />, summaryKey: 'settingsPanel.summaries.agent' },
  ui: { id: 'ui', labelKey: 'settings.tabs.ui', icon: <Palette size={14} />, summaryKey: 'settingsPanel.summaries.ui' },
  shortcuts: { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', icon: <Keyboard size={14} />, summaryKey: 'settingsPanel.summaries.shortcuts' },
  editor: { id: 'editor', labelKey: 'settings.tabs.editor', icon: <Code size={14} />, summaryKey: 'settingsPanel.summaries.editor' },
  zotero: { id: 'zotero', labelKey: 'settings.tabs.zotero', icon: <BookMarked size={14} />, summaryKey: 'settingsPanel.summaries.zotero' },
  selection: { id: 'selection', labelKey: 'settings.tabs.selection', icon: <Hand size={14} />, summaryKey: 'settingsPanel.summaries.selection' },
  compiler: { id: 'compiler', labelKey: 'settings.tabs.compiler', icon: <FileText size={14} />, summaryKey: 'settingsPanel.summaries.compiler' },
  update: { id: 'update', labelKey: 'settings.tabs.update', icon: <RefreshCw size={14} />, summaryKey: 'settingsPanel.summaries.update' },
};

// AI-first 分组:AI 引擎置顶,其后基础设定 → 科研工作流 → 系统;组内顺序即展示顺序。
const TAB_GROUPS: { titleKey: TranslationKey; ids: SettingsTab[] }[] = [
  { titleKey: 'settings.groups.aiEngine', ids: ['ai', 'agent'] },
  { titleKey: 'settings.groups.basics', ids: ['ui', 'shortcuts'] },
  { titleKey: 'settings.groups.workflow', ids: ['editor', 'zotero', 'selection', 'compiler'] },
  { titleKey: 'settings.groups.system', ids: ['update'] },
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

const TabNavButton: React.FC<{
  tab: TabMeta;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ tab, label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={clsx(
      'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
      active
        ? 'bg-[var(--color-accent)] text-white shadow-[0_8px_18px_rgba(15,157,223,0.18)]'
        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
    )}
    style={active ? undefined : { background: 'transparent' }}
    onMouseEnter={(event) => {
      if (!active) event.currentTarget.style.background = 'var(--color-bg-hover)';
    }}
    onMouseLeave={(event) => {
      if (!active) event.currentTarget.style.background = 'transparent';
    }}
  >
    <span className="flex h-4 w-4 items-center justify-center">{tab.icon}</span>
    <span className="truncate">{label}</span>
  </button>
);

export const SettingsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const storedTab = getStorageService().getString(SETTINGS_PANEL_TAB_KEY, 'ai') as SettingsTab;
    return TAB_META[storedTab] ? storedTab : 'ai';
  });
  const { t } = useTranslation();

  const activeMeta = useMemo(() => TAB_META[activeTab] ?? TAB_META.ai, [activeTab]);

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
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {TAB_GROUPS.map((group, index) => (
            <div key={group.titleKey} className="mb-2">
              <div
                className={clsx(
                  'px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]',
                  index === 0 ? 'mt-1' : 'mt-5'
                )}
              >
                {t(group.titleKey)}
              </div>
              <div className="space-y-1">
                {group.ids.map((id) => (
                  <TabNavButton
                    key={id}
                    tab={TAB_META[id]}
                    label={t(TAB_META[id].labelKey)}
                    active={activeTab === id}
                    onClick={() => setActiveTab(id)}
                  />
                ))}
              </div>
            </div>
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
