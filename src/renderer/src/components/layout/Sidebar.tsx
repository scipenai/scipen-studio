/**
 * @file Sidebar.tsx - Conversation sidebar
 * @description Manus/Codex-inspired left navigation with new chat, history, files, and settings
 */

import { FolderKanban, MessageSquare, Settings } from 'lucide-react';
import type React from 'react';
import { memo } from 'react';
import logoS from '../../assets/logo-s.svg';
import { useTranslation } from '../../locales';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useProjectPath, useSidebarTab } from '../../services/core/hooks';

const RailAction = memo(function RailAction({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-2xl border transition-all duration-200"
      style={
        active
          ? {
              borderColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
              background: 'var(--color-accent-muted)',
              color: 'var(--color-accent)',
              boxShadow: '0 10px 24px color-mix(in srgb, var(--color-accent) 14%, transparent)',
            }
          : {
              borderColor: 'transparent',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)',
              color: 'var(--color-text-muted)',
            }
      }
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'var(--color-border-subtle)';
        event.currentTarget.style.background =
          'color-mix(in srgb, var(--color-bg-primary) 92%, transparent)';
        event.currentTarget.style.color = 'var(--color-text-primary)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'transparent';
        event.currentTarget.style.background =
          'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)';
        event.currentTarget.style.color = 'var(--color-text-muted)';
      }}
    >
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
    </button>
  );
});

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
      className="flex w-[72px] flex-col items-center border-r px-3 py-4"
      style={{
        borderRightColor: 'var(--color-border-subtle)',
        background: 'color-mix(in srgb, var(--color-bg-primary) 96%, transparent)',
      }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-[20px] border"
        style={{
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <img src={logoS} alt="SciPen" className="h-6 w-6" />
      </div>

      <div className="mt-6 flex flex-1 flex-col items-center gap-3">
        <RailAction
          icon={<MessageSquare size={17} />}
          label={t('workspaceSidebar.imTab')}
          active={sidebarTab === 'im'}
          onClick={() => {
            uiService.setSidebarTab('im');
            uiService.setResearchLayoutFocus('chat');
          }}
        />
        <RailAction
          icon={<FolderKanban size={17} />}
          label={t('workspaceSidebar.filesTab')}
          active={sidebarTab === 'files'}
          onClick={() => {
            uiService.setSidebarTab('files');
            uiService.setResearchLayoutFocus('files');
          }}
        />
      </div>

      <div
        className="flex flex-col items-center gap-3 border-t pt-3"
        style={{ borderTopColor: 'var(--color-border-subtle)' }}
      >
        <RailAction
          icon={<Settings size={17} />}
          label={t('workspaceSidebar.settingsTab')}
          active={sidebarTab === 'settings'}
          onClick={() => {
            uiService.setSidebarTab('settings');
          }}
        />
        <div className="text-[10px] leading-4 text-[var(--color-text-muted)] text-center">
          {t('workspaceSidebar.subtitle')}
        </div>
      </div>
    </aside>
  );
};
