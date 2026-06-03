/**
 * @file WelcomeRecent.tsx - Welcome 屏右列上半:最近项目列表
 * @description 列表 / empty state 切换;时间格式化逻辑内聚
 */

import { motion } from 'framer-motion';
import { Clock, FileText, Loader2 } from 'lucide-react';
import type React from 'react';
import { useCallback } from 'react';
import { useTranslation } from '../../locales';
import type { RecentProjectSummary } from '../welcomeScreenHelpers';

export interface WelcomeRecentProps {
  projects: RecentProjectSummary[];
  openingPath: string | null;
  isOpeningAnyProject: boolean;
  onOpenRecent: (project: RecentProjectSummary) => void;
}

export const WelcomeRecent: React.FC<WelcomeRecentProps> = ({
  projects,
  openingPath,
  isOpeningAnyProject,
  onOpenRecent,
}) => {
  const { t } = useTranslation();

  const formatTimeAgo = useCallback(
    (timestamp: number): string => {
      try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '';
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);
        if (diffHours < 1) return t('welcome.justNow');
        if (diffHours < 24) return t('welcome.hoursAgo', { count: diffHours });
        if (diffDays === 1) return t('welcome.yesterday');
        if (diffDays < 7) return t('welcome.daysAgo', { count: diffDays });
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      } catch {
        return '';
      }
    },
    [t]
  );

  return (
    <div
      className="mb-4 rounded-2xl p-5 backdrop-blur-xl"
      style={{
        background: 'var(--welcome-card-bg)',
        border: '1px solid var(--welcome-card-border)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div className="mb-4 flex items-center gap-2">
        <Clock className="h-4 w-4" style={{ color: 'var(--color-accent)' }} />
        <h2
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {t('welcome.recentProjects')}
        </h2>
      </div>

      <div className="space-y-1">
        {projects.length > 0 ? (
          projects.slice(0, 5).map((project, index) => (
            <motion.button
              key={project.path}
              type="button"
              onClick={() => onOpenRecent(project)}
              disabled={isOpeningAnyProject}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + index * 0.05 }}
              whileHover={isOpeningAnyProject ? undefined : { x: 4 }}
              className={`group flex w-full items-center gap-3 rounded-xl p-3 text-left transition-all ${
                isOpeningAnyProject ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
              }`}
              style={{ background: 'transparent' }}
              onMouseEnter={(e) => {
                if (!isOpeningAnyProject)
                  e.currentTarget.style.background = 'var(--color-bg-hover)';
              }}
              onMouseLeave={(e) => {
                if (!isOpeningAnyProject) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
                style={{ background: 'var(--color-accent-muted)' }}
              >
                <FileText className="h-4 w-4 text-cyan-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium transition-colors group-hover:text-cyan-300"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {project.name}
                </p>
                <p className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {project.path}
                </p>
              </div>
              {openingPath === project.path ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--color-text-muted)]" />
              ) : (
                <span className="shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {formatTimeAgo(project.lastOpened)}
                </span>
              )}
            </motion.button>
          ))
        ) : (
          <div className="py-10 text-center">
            <div
              className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
              style={{ background: 'var(--color-bg-tertiary)' }}
            >
              <FileText className="h-8 w-8" style={{ color: 'var(--color-text-disabled)' }} />
            </div>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {t('welcome.noRecentProjects')}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('welcome.noRecentProjectsHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
