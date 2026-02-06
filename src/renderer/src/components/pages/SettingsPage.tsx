/**
 * @file SettingsPage.tsx - Fullscreen Settings Page
 * @description Fullscreen container page for settings and AI configuration
 */

import { motion } from 'framer-motion';
import { ArrowLeft, Bot, Settings, Sparkles } from 'lucide-react';
import type React from 'react';
import { Suspense, lazy } from 'react';
import { useTranslation } from '../../locales';
import { getUIService } from '../../services/core/ServiceRegistry';
import { useSidebarTab } from '../../services/core/hooks';

// Lazy load config panels to reduce initial bundle size
const AIConfigPanel = lazy(() =>
  import('../settings/ai/AIConfigPanel').then((m) => ({ default: m.AIConfigPanel }))
);

const GeneralSettingsPanel = lazy(() =>
  import('../SettingsPanel').then((m) => ({ default: m.SettingsPanel }))
);

const LoadingFallback = () => {
  const { t } = useTranslation();
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex items-center gap-3">
        <div
          className="w-6 h-6 rounded-full animate-spin"
          style={{
            border: '2px solid var(--color-border)',
            borderTopColor: 'var(--color-accent)',
          }}
        />
        <span style={{ color: 'var(--color-text-muted)' }}>{t('settingsPage.loading')}</span>
      </div>
    </div>
  );
};

const SETTINGS_TABS = [
  {
    id: 'aiconfig',
    labelKey: 'settingsPage.aiConfig',
    icon: Bot,
    descKey: 'settingsPage.aiConfigDesc',
  },
  {
    id: 'settings',
    labelKey: 'settingsPage.generalSettings',
    icon: Settings,
    descKey: 'settingsPage.generalSettingsDesc',
  },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const sidebarTab = useSidebarTab();
  const activeTab =
    sidebarTab === 'aiconfig' || sidebarTab === 'settings' ? sidebarTab : 'aiconfig';

  const handleBack = () => {
    getUIService().setSidebarTab('files');
  };

  const handleTabChange = (tabId: SettingsTabId) => {
    getUIService().setSidebarTab(tabId);
  };

  return (
    <div className="h-full w-full flex" style={{ background: 'var(--color-bg-primary)' }}>
      <div
        className="w-64 flex-shrink-0 flex flex-col"
        style={{
          background: 'var(--color-bg-void)',
          borderRight: '1px solid var(--color-border-subtle)',
        }}
      >
        <div className="p-5" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
          <motion.button
            onClick={handleBack}
            className="flex items-center gap-2 transition-colors cursor-pointer group"
            whileHover={{ x: -4 }}
            whileTap={{ scale: 0.98 }}
            style={{ color: 'var(--color-text-muted)' }}
          >
            <ArrowLeft
              size={18}
              className="group-hover:text-[var(--color-accent)] transition-colors"
            />
            <span className="text-sm font-medium group-hover:text-[var(--color-text-primary)] transition-colors">
              {t('settingsPage.backToEditor')}
            </span>
          </motion.button>
        </div>

        <nav className="flex-1 p-4">
          <div
            className="text-[11px] font-semibold uppercase tracking-wider mb-4 px-3"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('settingsPage.settings')}
          </div>
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <motion.button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                whileHover={{ x: 4 }}
                whileTap={{ scale: 0.98 }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl mb-2 transition-all cursor-pointer"
                style={{
                  background: isActive ? 'var(--color-accent-muted)' : 'transparent',
                  border: isActive ? '1px solid rgba(34, 211, 238, 0.2)' : '1px solid transparent',
                  color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center transition-all"
                  style={{
                    background: isActive
                      ? 'linear-gradient(135deg, rgba(34, 211, 238, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%)'
                      : 'var(--color-bg-tertiary)',
                  }}
                >
                  <Icon size={18} />
                </div>
                <div className="flex-1 text-left">
                  <span className="text-sm font-medium block">{t(tab.labelKey)}</span>
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    {t(tab.descKey)}
                  </span>
                </div>
                {isActive && (
                  <div
                    className="w-1.5 h-6 rounded-full"
                    style={{ background: 'var(--gradient-accent)' }}
                  />
                )}
              </motion.button>
            );
          })}
        </nav>

        <div className="p-5" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, #22d3ee 0%, #6366f1 100%)',
              }}
            >
              <Sparkles size={12} className="text-white" />
            </div>
            <div>
              <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                SciPen Studio
              </div>
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                v0.1.0 · Quantum Ink
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg-secondary)' }}>
        <Suspense fallback={<LoadingFallback />}>
          {activeTab === 'aiconfig' && <AIConfigPanel />}
          {activeTab === 'settings' && <GeneralSettingsPanel />}
        </Suspense>
      </div>
    </div>
  );
};
