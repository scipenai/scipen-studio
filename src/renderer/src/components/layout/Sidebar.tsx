/**
 * @file Sidebar.tsx - Workspace left navigation rail
 * @description Compact "icon + small label" rail: brand pinned at top, chat/files nav,
 *   settings pinned at the bottom. The active item is marked by an accent left bar plus a
 *   subtle accent-muted background (restrained emphasis, no glow).
 */

import { clsx } from 'clsx';
import { FolderKanban, History, MessageSquare, Settings } from 'lucide-react';
import type React from 'react';
import logoS from '../../assets/logo-s.svg';
import { useTranslation } from '../../locales';
import { historyUIBus } from '../../services/core/HistoryUIBus';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSidebarTab } from '../../services/core/hooks';

interface SidebarNavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

/** A single nav item: icon stacked above a small label. Active = accent left bar + accent-muted background (no glow). */
const SidebarNavItem: React.FC<SidebarNavItemProps> = ({ icon, label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-current={active ? 'page' : undefined}
    className={clsx(
      'relative flex w-full cursor-pointer flex-col items-center gap-1 rounded-lg px-1 py-2',
      'transition-colors focus:outline-none focus-visible:ring-2',
      'focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1',
      '[&>svg]:h-[18px] [&>svg]:w-[18px]',
      active
        ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
    )}
  >
    {active && (
      <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--color-accent)]" />
    )}
    {icon}
    <span className="text-[10px] font-medium leading-none">{label}</span>
  </button>
);

export const Sidebar: React.FC = () => {
  const uiService = getUIService();
  const { t } = useTranslation();
  const projectPath = useProjectPath();
  const sidebarTab = useSidebarTab();

  if (!projectPath) {
    return null;
  }

  return (
    <aside
      className={
        'flex w-[84px] flex-col items-center gap-1 border-r px-2 py-3 ' +
        'border-r-[var(--color-border-subtle)] ' +
        'bg-[color-mix(in_srgb,var(--color-bg-primary)_96%,transparent)]'
      }
    >
      {/* Brand: logo glyph plate + short wordmark */}
      <div className="mb-2 flex flex-col items-center gap-1">
        <div
          className={
            'flex h-11 w-11 items-center justify-center rounded-xl border ' +
            'border-[var(--color-border-subtle)] ' +
            'bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)]'
          }
        >
          <img src={logoS} alt="SciPen" className="h-6 w-6" />
        </div>
        <span className="text-[10px] font-semibold tracking-wide text-[var(--color-text-secondary)]">
          SciPen
        </span>
      </div>

      <nav className="flex w-full flex-1 flex-col gap-1">
        <SidebarNavItem
          icon={<MessageSquare />}
          label={t('workspaceSidebar.imTab')}
          active={sidebarTab === 'im'}
          onClick={() => {
            uiService.setSidebarTab('im');
            uiService.setResearchLayoutFocus('chat');
          }}
        />
        <SidebarNavItem
          icon={<FolderKanban />}
          label={t('workspaceSidebar.filesTab')}
          active={sidebarTab === 'files'}
          onClick={() => {
            uiService.setSidebarTab('files');
            uiService.setResearchLayoutFocus('files');
          }}
        />
      </nav>

      <div className="flex w-full flex-col gap-1 border-t pt-1 border-t-[var(--color-border-subtle)]">
        {/*
         * History: single entry that opens HistoryBrowserDialog. The dialog
         * internally tabs between Labels (manual snapshots) and Sessions
         * (AI step DAG). One sidebar button matches the one dialog.
         */}
        <SidebarNavItem
          icon={<History />}
          label={t('workspaceSidebar.historyTab')}
          active={false}
          onClick={() => historyUIBus.openBrowseLabels()}
        />
        <SidebarNavItem
          icon={<Settings />}
          label={t('workspaceSidebar.settingsTab')}
          active={sidebarTab === 'settings'}
          onClick={() => uiService.setSidebarTab('settings')}
        />
      </div>
    </aside>
  );
};
