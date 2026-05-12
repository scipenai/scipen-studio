/**
 * @file WelcomeScreen.tsx - Welcome screen
 * @description Visual design from the main branch (split columns + glow background); business
 * logic uses the refactor branch (bootstrapExistingProject + OverleafDownloadDialog).
 */

import { motion } from 'framer-motion';
import {
  Clock,
  Cloud,
  FileText,
  FolderOpen,
  Lightbulb,
  Loader2,
  Sparkles,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import logoFull from '../assets/logo-full.svg';
import { useTranslation } from '../locales';
import type { FileNode } from '../types';
import { OverleafDownloadDialog } from './OverleafDownloadDialog';
import { bootstrapExistingProject, type RecentProjectSummary } from './welcomeScreenHelpers';

export const WelcomeScreen: React.FC = () => {
  const { t } = useTranslation();

  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [isOpeningProject, setIsOpeningProject] = useState(false);
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const isOpeningAnyProject = isOpeningProject || openingRecentPath !== null;

  useEffect(() => {
    api.app
      .getVersion()
      .then((version) => setAppVersion(version))
      .catch((error) => console.error('Failed to load app version:', error));
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const projects = await api.project.getRecent();
        setRecentProjects(
          projects.map((p) => {
            const timestamp = p.lastOpened && p.lastOpened > 0 ? p.lastOpened : Date.now();
            return { ...p, lastOpened: timestamp };
          })
        );
      } catch (error) {
        console.error('Failed to load recent projects:', error);
      }
    };
    void load();
  }, []);

  const handleOpenProject = async () => {
    if (isOpeningAnyProject) return;
    if (!api.project.open) {
      alert(t('welcome.useInElectron'));
      return;
    }
    try {
      setIsOpeningProject(true);
      const result = await api.project.open();
      if (result) {
        await bootstrapExistingProject(result.projectPath, result.fileTree as FileNode);
      }
    } catch (error) {
      console.error('Failed to open project:', error);
      alert(
        `${t('welcome.openProjectFailed')}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      setIsOpeningProject(false);
    }
  };

  const handleOpenRecentProject = async (project: RecentProjectSummary) => {
    if (isOpeningAnyProject) return;
    if (!api.project.openByPath) {
      alert(t('welcome.useInElectron'));
      return;
    }
    try {
      setOpeningRecentPath(project.path);
      const result = await api.project.openByPath(project.path);
      if (result) {
        await bootstrapExistingProject(result.projectPath, result.fileTree as FileNode);
      }
    } catch (error) {
      console.error('Failed to open recent project:', error);
    } finally {
      setOpeningRecentPath(null);
    }
  };

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: 'var(--color-bg-void)' }}
    >
      {/* Dynamic Background */}
      <div className="welcome-bg-gradient absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 50% -20%, var(--welcome-glow-primary), transparent)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 50% 80% at 100% 50%, var(--welcome-glow-secondary), transparent)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 50% 50% at 0% 100%, var(--welcome-glow-primary), transparent)',
            opacity: 0.6,
          }}
        />
        {/* Grid Pattern */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(var(--welcome-grid-color) 1px, transparent 1px),
              linear-gradient(90deg, var(--welcome-grid-color) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px',
          }}
        />
        {/* Glow Orbs */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 1.2 }}
          className="absolute left-[20%] top-[15%] h-[500px] w-[500px] rounded-full blur-[150px]"
          style={{
            background: 'radial-gradient(circle, var(--welcome-glow-primary) 0%, transparent 70%)',
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 1.5 }}
          className="absolute bottom-[20%] right-[15%] h-[400px] w-[400px] rounded-full blur-[120px]"
          style={{
            background:
              'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 1.8 }}
          className="absolute left-[10%] top-[60%] h-[300px] w-[300px] rounded-full blur-[100px]"
          style={{
            background: 'radial-gradient(circle, var(--welcome-glow-primary) 0%, transparent 70%)',
            opacity: 0.7,
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 2 }}
          className="absolute right-[25%] top-[10%] h-[250px] w-[250px] rounded-full blur-[80px]"
          style={{
            background:
              'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
            opacity: 0.5,
          }}
        />
      </div>

      {/* Content Area */}
      <div className="relative z-10 mx-auto flex max-w-6xl items-start gap-16 px-8 py-12">
        {/* Left Column */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.6 }}
          className="max-w-md shrink-0"
        >
          {/* Logo & Title */}
          <div className="mb-6 flex flex-col gap-4">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
            >
              <img src={logoFull} alt="SciPen" className="h-16 w-auto" />
            </motion.div>
            <div>
              <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
                {t('welcome.title')}
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                {appVersion ? `v${appVersion}` : ''}
              </p>
            </div>
          </div>

          {/* Subtitle */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="mb-8"
          >
            <p className="mb-2 text-xl font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {t('welcome.subtitle')}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {t('welcome.description')}
            </p>
          </motion.div>

          {/* Action Cards */}
          <div className="mb-6 grid grid-cols-2 gap-3">
            <motion.button
              type="button"
              onClick={() => {
                void handleOpenProject();
              }}
              disabled={isOpeningAnyProject}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              whileHover={
                isOpeningAnyProject
                  ? undefined
                  : { y: -4, boxShadow: '0 12px 40px rgba(245,158,11,0.15)' }
              }
              whileTap={isOpeningAnyProject ? undefined : { scale: 0.98 }}
              className={`group relative overflow-hidden rounded-2xl p-5 text-left transition-all duration-300 ${
                isOpeningAnyProject ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
              }`}
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div
                className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background: 'linear-gradient(135deg, rgba(245,158,11,0.1) 0%, transparent 60%)',
                }}
              />
              <div className="relative">
                <div
                  className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-110"
                  style={{ background: 'rgba(245,158,11,0.15)' }}
                >
                  {isOpeningProject ? (
                    <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
                  ) : (
                    <FolderOpen className="h-5 w-5 text-amber-400" />
                  )}
                </div>
                <h3
                  className="mb-1 text-sm font-semibold"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {t('welcome.openLocal')}
                </h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t('welcome.openLocalDesc')}
                </p>
              </div>
            </motion.button>

            <motion.button
              type="button"
              onClick={() => {
                setShowRemoteDialog(true);
              }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              whileHover={{ y: -4, boxShadow: '0 12px 40px rgba(139,92,246,0.15)' }}
              whileTap={{ scale: 0.98 }}
              className="group relative cursor-pointer overflow-hidden rounded-2xl p-5 text-left transition-all duration-300"
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div
                className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.1) 0%, transparent 60%)',
                }}
              />
              <div className="relative">
                <div
                  className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-110"
                  style={{ background: 'rgba(139,92,246,0.15)' }}
                >
                  <Cloud className="h-5 w-5 text-violet-400" />
                </div>
                <h3
                  className="mb-1 text-sm font-semibold"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {t('welcome.openRemote')}
                </h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t('welcome.openRemoteDesc')}
                </p>
              </div>
            </motion.button>
          </div>

          {/* Feature Highlights */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="flex items-center gap-4 text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <div className="flex items-center gap-1.5">
              <Sparkles size={12} className="text-cyan-400" />
              <span>{t('welcome.featureAI')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Cloud size={12} className="text-violet-400" />
              <span>{t('welcome.featureOverleaf')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={12} className="text-amber-400" />
              <span>{t('welcome.featurePreview')}</span>
            </div>
          </motion.div>
        </motion.div>

        {/* Right Column */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="max-w-md flex-1"
        >
          {/* Recent Projects */}
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
              {recentProjects.length > 0 ? (
                recentProjects.slice(0, 5).map((project, index) => (
                  <motion.button
                    key={project.path}
                    type="button"
                    onClick={() => {
                      void handleOpenRecentProject(project);
                    }}
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
                    {openingRecentPath === project.path ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--color-text-muted)]" />
                    ) : (
                      <span
                        className="shrink-0 text-xs"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
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

          {/* Pro Tip */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="rounded-2xl p-4"
            style={{
              background: 'var(--welcome-tip-bg)',
              border: '1px solid var(--welcome-tip-border)',
            }}
          >
            <div className="flex items-start gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                style={{ background: 'var(--color-accent-muted)' }}
              >
                <Lightbulb className="h-5 w-5" style={{ color: 'var(--color-accent)' }} />
              </div>
              <div>
                <h3
                  className="mb-1.5 text-sm font-semibold"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {t('welcome.proTipTitle')}
                </h3>
                <p
                  className="text-xs leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {t('welcome.proTipDesc', { shortcut: '' })}
                  <kbd
                    className="mx-0.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
                    style={{
                      background: 'var(--color-accent-muted)',
                      border: '1px solid var(--welcome-tip-border)',
                      color: 'var(--color-accent)',
                    }}
                  >
                    Ctrl+Shift+P
                  </kbd>
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>

      {/* Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
        className="absolute bottom-6 left-0 right-0 text-center"
      >
        <p className="text-xs" style={{ color: 'var(--color-text-disabled)' }}>
          SciPen Studio · {t('welcome.footer')}
        </p>
      </motion.div>

      {/* Overleaf download dialog (local-first mode) */}
      <OverleafDownloadDialog open={showRemoteDialog} onClose={() => setShowRemoteDialog(false)} />
    </motion.div>
  );
};
