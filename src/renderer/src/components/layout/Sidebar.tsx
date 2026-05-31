/**
 * @file Sidebar.tsx - Conversation sidebar
 * @description Manus/Codex-inspired left navigation with new chat, history, files, and settings
 */

import { FolderKanban, MessageSquare, Settings } from 'lucide-react';
import type React from 'react';
import logoS from '../../assets/logo-s.svg';
import { useTranslation } from '../../locales';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSidebarTab } from '../../services/core/hooks';
import { IconButton } from '../ui';

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
        'flex w-[72px] flex-col items-center border-r px-3 py-4 ' +
        'border-r-[var(--color-border-subtle)] ' +
        'bg-[color-mix(in_srgb,var(--color-bg-primary)_96%,transparent)]'
      }
    >
      <div
        className={
          'flex h-12 w-12 items-center justify-center rounded-[20px] border ' +
          'border-[var(--color-border-subtle)] ' +
          'bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)] ' +
          'shadow-[var(--shadow-sm)]'
        }
      >
        <img src={logoS} alt="SciPen" className="h-6 w-6" />
      </div>

      <div className="mt-6 flex flex-1 flex-col items-center gap-3">
        <IconButton
          variant="rail"
          active={sidebarTab === 'im'}
          tooltip={t('workspaceSidebar.imTab')}
          aria-label={t('workspaceSidebar.imTab')}
          onClick={() => {
            uiService.setSidebarTab('im');
            uiService.setResearchLayoutFocus('chat');
          }}
        >
          <MessageSquare />
        </IconButton>
        <IconButton
          variant="rail"
          active={sidebarTab === 'files'}
          tooltip={t('workspaceSidebar.filesTab')}
          aria-label={t('workspaceSidebar.filesTab')}
          onClick={() => {
            uiService.setSidebarTab('files');
            uiService.setResearchLayoutFocus('files');
          }}
        >
          <FolderKanban />
        </IconButton>
      </div>

      <div className="flex flex-col items-center gap-3 border-t pt-3 border-t-[var(--color-border-subtle)]">
        <IconButton
          variant="rail"
          active={sidebarTab === 'settings'}
          tooltip={t('workspaceSidebar.settingsTab')}
          aria-label={t('workspaceSidebar.settingsTab')}
          onClick={() => {
            uiService.setSidebarTab('settings');
          }}
        >
          <Settings />
        </IconButton>
        <div className="text-[10px] leading-4 text-[var(--color-text-muted)] text-center">
          {t('workspaceSidebar.subtitle')}
        </div>
      </div>
    </aside>
  );
};
