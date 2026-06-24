/**
 * @file WelcomeScreen.tsx - Welcome screen (orchestrator).
 * @description State + effects + handlers; composes welcome/* sub-components + OverleafDownloadDialog.
 */

import { motion } from 'framer-motion';
import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../locales';
import type { FileNode } from '../types';
import { OverleafDownloadDialog } from './OverleafDownloadDialog';
import { WelcomeBackdrop, WelcomeFooter, WelcomeHero, WelcomeRecent, WelcomeTips } from './welcome';
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: 'var(--color-bg-void)' }}
    >
      <WelcomeBackdrop />

      {/* Content Area */}
      <div className="relative z-10 mx-auto flex max-w-6xl items-start gap-16 px-8 py-12">
        {/* Left Column */}
        <WelcomeHero
          appVersion={appVersion}
          isOpeningProject={isOpeningProject}
          isOpeningAnyProject={isOpeningAnyProject}
          onOpenProject={() => {
            void handleOpenProject();
          }}
          onOpenRemote={() => {
            setShowRemoteDialog(true);
          }}
        />

        {/* Right Column */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="max-w-md flex-1"
        >
          <WelcomeRecent
            projects={recentProjects}
            openingPath={openingRecentPath}
            isOpeningAnyProject={isOpeningAnyProject}
            onOpenRecent={(project) => {
              void handleOpenRecentProject(project);
            }}
          />
          <WelcomeTips />
        </motion.div>
      </div>

      <WelcomeFooter />

      {/* Overleaf download dialog (local-first mode) */}
      <OverleafDownloadDialog open={showRemoteDialog} onClose={() => setShowRemoteDialog(false)} />
    </motion.div>
  );
};
