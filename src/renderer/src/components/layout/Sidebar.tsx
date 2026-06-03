/**
 * @file Sidebar.tsx - 工作台左侧导航轨
 * @description 紧凑「图标+小字」轨:品牌置顶,对话/文件导航,设置居底。
 *   活动项以 accent 左条 + 轻 accent-muted 底标识(强调收敛,无 glow)。
 */

import { clsx } from 'clsx';
import { FolderKanban, MessageSquare, Settings } from 'lucide-react';
import type React from 'react';
import logoS from '../../assets/logo-s.svg';
import { useTranslation } from '../../locales';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSidebarTab } from '../../services/core/hooks';

interface SidebarNavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

/** 单个导航项:图标竖叠小字标签。活动 = accent 左条 + accent-muted 底(无 glow)。 */
const SidebarNavItem: React.FC<SidebarNavItemProps> = ({ icon, label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-current={active ? 'page' : undefined}
    className={clsx(
      'relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2',
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
      {/* 品牌:logo 字符牌 + 简短 wordmark */}
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

      <div className="w-full border-t pt-1 border-t-[var(--color-border-subtle)]">
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
