/**
 * @file WelcomeScreen.tsx - Welcome Screen
 * @description App startup guide page showing recent projects, quick entries for local/remote projects, and Overleaf integration
 * @depends api, services/core, framer-motion
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Lightbulb,
  Loader2,
  RefreshCw,
  Settings,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import logoFull from '../assets/logo-full.svg';
import { useTranslation } from '../locales';
import {
  getEditorService,
  getProjectService,
  getSettingsService,
  useCompilerSettings,
} from '../services/core';
import type { FileNode } from '../types';

// ====== Overleaf Types ======

interface OverleafProject {
  id: string;
  name: string;
  lastUpdated?: string;
  owner?: { id: string; email: string; firstName?: string; lastName?: string };
  accessLevel?: 'owner' | 'readAndWrite' | 'readOnly' | string;
  compiler?: string;
}

interface OverleafDoc {
  _id: string;
  name: string;
}

interface OverleafFileRef {
  _id: string;
  name: string;
}

interface OverleafFolder {
  _id?: string;
  name: string;
  docs?: OverleafDoc[];
  fileRefs?: OverleafFileRef[];
  folders?: OverleafFolder[];
}

// ====== Local Types ======

interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
  isRemote?: boolean;
}

// ====== Main Component ======

export const WelcomeScreen: React.FC = () => {
  const compilerSettings = useCompilerSettings();
  const { t } = useTranslation();

  // ====== State ======

  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [remoteProjects, setRemoteProjects] = useState<OverleafProject[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedProject, setSelectedProject] = useState<OverleafProject | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isOpeningProject, setIsOpeningProject] = useState(false);
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  const isOpeningAnyProject = isOpeningProject || openingRecentPath !== null;
  const [showCookieSetup, setShowCookieSetup] = useState(false);
  const [tempServerUrl, setTempServerUrl] = useState('');
  const [tempCookies, setTempCookies] = useState('');
  const [showCookies, setShowCookies] = useState(false);

  // ====== Effects ======

  useEffect(() => {
    const loadRecentProjects = async () => {
      try {
        if (api.project.getRecent) {
          const projects = await api.project.getRecent();
          setRecentProjects(
            projects.map((p) => {
              // Why: lastOpened may be invalid (0 or negative) from corrupted storage
              const timestamp = p.lastOpened && p.lastOpened > 0 ? p.lastOpened : Date.now();
              return {
                ...p,
                id: p.path,
                lastOpened: new Date(timestamp).toISOString(),
              };
            }) || []
          );
        }
      } catch (error) {
        console.error('Failed to load recent projects:', error);
      }
    };
    loadRecentProjects();
  }, []);

  // ====== Event Handlers ======

  const handleOpenProject = async () => {
    if (isOpeningProject || openingRecentPath) {
      return;
    }
    if (!api.project.open) {
      alert(t('welcome.useInElectron'));
      return;
    }

    try {
      setIsOpeningProject(true);
      const result = await api.project.open();
      if (result) {
        // Why: Local projects should not use Overleaf engine
        if (compilerSettings.engine === 'overleaf') {
          getSettingsService().updateCompiler({ engine: 'xelatex' });
        }
        getProjectService().setProject(result.projectPath, result.fileTree as FileNode);
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

  const handleOpenRecentProject = async (project: RecentProject) => {
    try {
      if (project.isRemote) {
        // TODO: Implement remote project reopening
      } else {
        if (api.project.openByPath) {
          if (isOpeningProject || openingRecentPath) {
            return;
          }
          setOpeningRecentPath(project.path);
          const result = await api.project.openByPath(project.path);
          if (result) {
            // Why: Local projects should not use Overleaf engine
            if (compilerSettings.engine === 'overleaf') {
              getSettingsService().updateCompiler({ engine: 'xelatex' });
            }
            getProjectService().setProject(result.projectPath, result.fileTree as FileNode);
          }
          setOpeningRecentPath(null);
        }
      }
    } catch (error) {
      console.error('Failed to open recent project:', error);
      setOpeningRecentPath(null);
    }
  };

  const handleOpenRemoteProject = async () => {
    setShowRemoteDialog(true);
    setRemoteError(null);
    setSelectedProject(null);

    const { cookies, serverUrl } = compilerSettings.overleaf;

    if (!cookies) {
      setShowCookieSetup(true);
      setTempServerUrl(serverUrl || 'https://www.overleaf.com');
      setTempCookies('');
      return;
    }

    setShowCookieSetup(false);
    await connectAndLoadProjects();
  };

  const handleSaveCookieAndConnect = async () => {
    if (!tempCookies.trim()) {
      setRemoteError(t('welcome.remoteDialog.cookiesRequired'));
      return;
    }

    getSettingsService().updateCompiler({
      overleaf: {
        ...compilerSettings.overleaf,
        serverUrl: tempServerUrl || 'https://www.overleaf.com',
        cookies: tempCookies.trim(),
      },
    });

    setShowCookieSetup(false);
    setRemoteError(null);

    // Why: Small delay to ensure settings are persisted before connecting
    setTimeout(async () => {
      await connectAndLoadProjects();
    }, 100);
  };

  const connectAndLoadProjects = async () => {
    const { serverUrl, cookies } = compilerSettings.overleaf;

    if (!cookies) {
      setRemoteError(t('welcome.remoteDialog.cookiesRequired'));
      return;
    }

    setIsConnecting(true);
    setRemoteError(null);

    try {
      await api.overleaf.init({
        serverUrl: serverUrl || 'https://www.overleaf.com',
        cookies,
      });

      const loginResult = await api.overleaf.login({
        serverUrl: serverUrl || 'https://www.overleaf.com',
        cookies,
      });

      if (!loginResult?.success) {
        throw new Error(loginResult?.message || t('common.error'));
      }

      setIsLoggedIn(true);
      setIsConnecting(false);

      await loadRemoteProjects();
    } catch (error) {
      console.error('Failed to connect to Overleaf:', error);
      setRemoteError(error instanceof Error ? error.message : t('common.error'));
      setIsConnecting(false);
      setIsLoggedIn(false);
    }
  };

  const loadRemoteProjects = async () => {
    setIsLoadingProjects(true);
    setRemoteError(null);

    try {
      const result = await api.overleaf.getProjects();

      if (!result) {
        throw new Error(t('common.error'));
      }

      setRemoteProjects(
        (result || []).map((p) => ({
          ...p,
          lastUpdated: p.lastUpdated || new Date().toISOString(),
        }))
      );
    } catch (error) {
      console.error('Failed to load project list:', error);
      setRemoteError(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const handleOpenSelectedProject = async () => {
    if (!selectedProject) return;

    setIsConnecting(true);
    setRemoteError(null);

    try {
      const detailsResult = await api.overleaf.getProjectDetails(selectedProject.id);

      if (!detailsResult?.success || !detailsResult.details) {
        throw new Error(t('common.error'));
      }

      const projectDetails = detailsResult.details;
      const projectId = selectedProject.id;
      const projectName = selectedProject.name;
      const remotePath = `overleaf://${projectId}`;

      const fileTree = convertOverleafToFileTree(
        (projectDetails.rootFolder || []) as OverleafFolder[],
        projectName,
        projectId
      );

      getSettingsService().updateCompiler({
        engine: 'overleaf',
        overleaf: {
          ...compilerSettings.overleaf,
          projectId: projectId,
          remoteCompiler:
            ((projectDetails as { compiler?: string }).compiler as
              | 'pdflatex'
              | 'xelatex'
              | 'lualatex') || 'pdflatex',
        },
      });

      getProjectService().setProject(remotePath, fileTree as FileNode);

      const rootDocId = (projectDetails as { rootDoc_id?: string }).rootDoc_id;
      if (rootDocId) {
        const rootDocContent = await api.overleaf.getDoc(projectId, rootDocId);
        if (rootDocContent?.success && rootDocContent.content) {
          const rootDocPath = findDocPath(
            (projectDetails.rootFolder || []) as OverleafFolder[],
            rootDocId
          );
          const docFileName = rootDocPath?.split('/').pop() || 'main.tex';
          getEditorService().addTab({
            path: `${remotePath}/${rootDocPath || 'main.tex'}`,
            name: docFileName,
            content: rootDocContent.content,
            isDirty: false,
            language: 'latex',
            _id: rootDocId,
            isRemote: true,
          });
        }
      }

      setShowRemoteDialog(false);
    } catch (error) {
      console.error('Failed to open remote project:', error);
      setRemoteError(error instanceof Error ? error.message : t('welcome.openProjectFailed'));
    } finally {
      setIsConnecting(false);
    }
  };

  // ====== Utility Functions ======

  /**
   * Converts Overleaf nested folder structure to unified FileNode tree.
   * Overleaf returns folders/docs/fileRefs, we flatten to consistent FileNode format.
   */
  const convertOverleafToFileTree = (
    folders: OverleafFolder[],
    projectName: string,
    projectId: string
  ): FileNode => {
    const basePath = `overleaf://${projectId}`;

    const convertFolder = (items: OverleafFolder[], parentPath: string): FileNode[] => {
      const result: FileNode[] = [];

      for (const item of items) {
        if (item.docs) {
          result.push({
            name: item.name,
            path: `${parentPath}/${item.name}`,
            type: 'directory',
            children: [
              ...(item.docs || []).map((doc: OverleafDoc) => ({
                name: doc.name,
                path: `${parentPath}/${item.name}/${doc.name}`,
                type: 'file' as const,
                _id: doc._id,
              })),
              ...(item.fileRefs || []).map((file: OverleafFileRef) => ({
                name: file.name,
                path: `${parentPath}/${item.name}/${file.name}`,
                type: 'file' as const,
                _id: file._id,
                isFileRef: true,
              })),
              ...convertFolder(item.folders || [], `${parentPath}/${item.name}`),
            ],
          });
        } else if (item._id) {
          result.push({
            name: item.name,
            path: `${parentPath}/${item.name}`,
            type: 'file',
            _id: item._id,
          });
        }
      }

      return result;
    };

    const rootFolder = folders[0] || { docs: [], fileRefs: [], folders: [] };
    const children: FileNode[] = [
      ...(rootFolder.docs || []).map((doc: OverleafDoc) => ({
        name: doc.name,
        path: `${basePath}/${doc.name}`,
        type: 'file' as const,
        _id: doc._id,
      })),
      ...(rootFolder.fileRefs || []).map((file: OverleafFileRef) => ({
        name: file.name,
        path: `${basePath}/${file.name}`,
        type: 'file' as const,
        _id: file._id,
        isFileRef: true,
      })),
      ...convertFolder(rootFolder.folders || [], basePath),
    ];

    return {
      name: projectName,
      path: basePath,
      type: 'directory',
      children,
      isRemote: true,
    };
  };

  /** Finds document path by ID within Overleaf folder structure */
  const findDocPath = (
    folders: OverleafFolder[],
    docId: string,
    _currentPath = ''
  ): string | null => {
    const rootFolder = folders[0] || { docs: [], folders: [] };

    for (const doc of rootFolder.docs || []) {
      if (doc._id === docId) {
        return doc.name;
      }
    }

    const searchInFolder = (folder: OverleafFolder, path: string): string | null => {
      for (const doc of folder.docs || []) {
        if (doc._id === docId) {
          return `${path}/${doc.name}`;
        }
      }
      for (const subFolder of folder.folders || []) {
        const result = searchInFolder(subFolder, `${path}/${subFolder.name}`);
        if (result) return result;
      }
      return null;
    };

    for (const folder of rootFolder.folders || []) {
      const result = searchInFolder(folder, folder.name);
      if (result) return result;
    }

    return null;
  };

  const formatTimeAgo = useCallback(
    (dateStr: string | undefined | null): string => {
      if (!dateStr) return '';
      try {
        const date = new Date(dateStr);
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

  // ====== Render ======

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 flex items-center justify-center relative overflow-hidden"
      style={{ background: 'var(--color-bg-void)' }}
    >
      {/* Dynamic Background */}
      <div className="absolute inset-0 overflow-hidden welcome-bg-gradient">
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
          className="absolute top-[15%] left-[20%] w-[500px] h-[500px] rounded-full blur-[150px]"
          style={{
            background: 'radial-gradient(circle, var(--welcome-glow-primary) 0%, transparent 70%)',
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 1.5 }}
          className="absolute bottom-[20%] right-[15%] w-[400px] h-[400px] rounded-full blur-[120px]"
          style={{
            background:
              'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 1.8 }}
          className="absolute top-[60%] left-[10%] w-[300px] h-[300px] rounded-full blur-[100px]"
          style={{
            background:
              'radial-gradient(circle, var(--welcome-glow-tertiary, var(--welcome-glow-primary)) 0%, transparent 70%)',
            opacity: 0.7,
          }}
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 2 }}
          className="absolute top-[10%] right-[25%] w-[250px] h-[250px] rounded-full blur-[80px]"
          style={{
            background:
              'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
            opacity: 0.5,
          }}
        />
      </div>

      {/* Content Area */}
      <div className="relative z-10 flex items-start gap-16 max-w-6xl mx-auto px-8 py-12">
        {/* Left Column */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.6 }}
          className="flex-shrink-0 max-w-md"
        >
          {/* Logo & Title */}
          <div className="flex flex-col gap-4 mb-6">
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
              <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
                v0.1.0
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
            <p className="text-xl font-medium mb-2" style={{ color: 'var(--color-text-primary)' }}>
              {t('welcome.subtitle')}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {t('welcome.description')}
            </p>
          </motion.div>

          {/* Action Cards */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <motion.button
              onClick={handleOpenProject}
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
              className={`group relative p-5 rounded-2xl text-left overflow-hidden transition-all duration-300 ${
                isOpeningAnyProject ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
              }`}
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{
                  background: 'linear-gradient(135deg, rgba(245,158,11,0.1) 0%, transparent 60%)',
                }}
              />
              <div className="relative">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 transition-transform group-hover:scale-110"
                  style={{ background: 'rgba(245,158,11,0.15)' }}
                >
                  {isOpeningProject ? (
                    <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
                  ) : (
                    <FolderOpen className="w-5 h-5 text-amber-400" />
                  )}
                </div>
                <h3
                  className="font-semibold text-sm mb-1"
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
              onClick={handleOpenRemoteProject}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              whileHover={{ y: -4, boxShadow: '0 12px 40px rgba(139,92,246,0.15)' }}
              whileTap={{ scale: 0.98 }}
              className="group relative p-5 rounded-2xl text-left cursor-pointer overflow-hidden transition-all duration-300"
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.1) 0%, transparent 60%)',
                }}
              />
              <div className="relative">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 transition-transform group-hover:scale-110"
                  style={{ background: 'rgba(139,92,246,0.15)' }}
                >
                  <Cloud className="w-5 h-5 text-violet-400" />
                </div>
                <h3
                  className="font-semibold text-sm mb-1"
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
              <BookOpen size={12} className="text-violet-400" />
              <span>{t('welcome.featureKnowledge')}</span>
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
          className="flex-1 max-w-md"
        >
          {/* Recent Projects */}
          <div
            className="rounded-2xl p-5 mb-4 backdrop-blur-xl"
            style={{
              background: 'var(--welcome-card-bg)',
              border: '1px solid var(--welcome-card-border)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4" style={{ color: 'var(--color-accent)' }} />
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
                    key={project.id}
                    onClick={() => handleOpenRecentProject(project)}
                    disabled={isOpeningAnyProject}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.4 + index * 0.05 }}
                    whileHover={isOpeningAnyProject ? undefined : { x: 4 }}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all text-left group ${
                      isOpeningAnyProject ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
                    }`}
                    style={{ background: 'transparent' }}
                    onMouseEnter={(e) => {
                      if (isOpeningAnyProject) return;
                      e.currentTarget.style.background = 'var(--color-bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (isOpeningAnyProject) return;
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
                      style={{ background: 'var(--color-accent-muted)' }}
                    >
                      <FileText className="w-4 h-4 text-cyan-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-medium truncate group-hover:text-cyan-300 transition-colors"
                        style={{ color: 'var(--color-text-primary)' }}
                      >
                        {project.name}
                      </p>
                      <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                        {project.path}
                      </p>
                    </div>
                    {openingRecentPath === project.path ? (
                      <Loader2 className="w-3 h-3 text-[var(--color-text-muted)] animate-spin flex-shrink-0" />
                    ) : (
                      <span
                        className="text-xs flex-shrink-0"
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
                    className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
                    style={{ background: 'var(--color-bg-tertiary)' }}
                  >
                    <FileText className="w-8 h-8" style={{ color: 'var(--color-text-disabled)' }} />
                  </div>
                  <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('welcome.noRecentProjects')}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
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
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--color-accent-muted)' }}
              >
                <Lightbulb className="w-5 h-5" style={{ color: 'var(--color-accent)' }} />
              </div>
              <div>
                <h3
                  className="text-sm font-semibold mb-1.5"
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
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono mx-0.5"
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

      {/* Remote Project Dialog */}
      <AnimatePresence>
        {showRemoteDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 flex items-center justify-center z-50 backdrop-blur-md"
            style={{ background: 'var(--color-backdrop)' }}
            onClick={() => setShowRemoteDialog(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="rounded-2xl p-6 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 25px 80px rgba(0,0,0,0.5), 0 0 60px rgba(34,211,238,0.1)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Dialog Header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center"
                    style={{
                      background:
                        'linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(34,211,238,0.2) 100%)',
                    }}
                  >
                    <Cloud className="w-5 h-5 text-[var(--color-success)]" />
                  </div>
                  <div>
                    <h2
                      className="text-lg font-semibold"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {t('welcome.remoteDialog.title')}
                    </h2>
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {t('welcome.remoteDialog.subtitle')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowRemoteDialog(false)}
                  className="p-2 rounded-lg transition-all hover:scale-105"
                  style={{ background: 'var(--color-bg-hover)' }}
                >
                  <X className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
                </button>
              </div>

              {/* Cookie Setup Form */}
              {showCookieSetup && !isConnecting && (
                <div className="space-y-4">
                  <div className="p-4 bg-[var(--color-warning-muted)] border border-[var(--color-warning)]/20 rounded-lg">
                    <div className="flex items-start gap-3">
                      <Settings className="w-5 h-5 text-[var(--color-warning)] mt-0.5" />
                      <div>
                        <p
                          className="text-sm font-medium"
                          style={{ color: 'var(--color-warning)' }}
                        >
                          {t('welcome.remoteDialog.configRequired')}
                        </p>
                        <p
                          className="text-xs mt-1"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {t('welcome.remoteDialog.configHint')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label
                      className="block text-xs font-medium mb-1.5"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('welcome.remoteDialog.serverUrl')}
                    </label>
                    <input
                      type="text"
                      value={tempServerUrl}
                      onChange={(e) => setTempServerUrl(e.target.value)}
                      placeholder="https://www.overleaf.com"
                      className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
                      style={{
                        background: 'var(--color-bg-tertiary)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-primary)',
                      }}
                    />
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                      {t('welcome.remoteDialog.serverUrlHint')}
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-xs font-medium mb-1.5"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('welcome.remoteDialog.cookies')}{' '}
                      <span className="text-[var(--color-error)]">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showCookies ? 'text' : 'password'}
                        value={tempCookies}
                        onChange={(e) => setTempCookies(e.target.value)}
                        placeholder="overleaf_session2=..."
                        className="w-full px-3 py-2 pr-10 rounded-lg text-sm focus:outline-none transition-colors"
                        style={{
                          background: 'var(--color-bg-tertiary)',
                          border: '1px solid var(--color-border)',
                          color: 'var(--color-text-primary)',
                        }}
                      />
                      <button
                        onClick={() => setShowCookies(!showCookies)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-[var(--color-bg-hover)] rounded"
                      >
                        {showCookies ? (
                          <EyeOff
                            className="w-4 h-4"
                            style={{ color: 'var(--color-text-muted)' }}
                          />
                        ) : (
                          <Eye className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="p-3 bg-[var(--color-info-muted)] border border-[var(--color-info)]/20 rounded-lg">
                    <h4 className="text-xs font-medium mb-2" style={{ color: 'var(--color-info)' }}>
                      {t('welcome.remoteDialog.howToGetCookie')}
                    </h4>
                    <ol
                      className="text-xs space-y-1 list-decimal list-inside"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      <li>{t('welcome.remoteDialog.cookieStep1')}</li>
                      <li>{t('welcome.remoteDialog.cookieStep2')}</li>
                      <li>{t('welcome.remoteDialog.cookieStep3')}</li>
                      <li>
                        {t('welcome.remoteDialog.cookieStep4')}{' '}
                        <code
                          className="px-1 py-0.5 rounded"
                          style={{ background: 'var(--color-bg-tertiary)' }}
                        >
                          overleaf_session2
                        </code>
                      </li>
                    </ol>
                  </div>

                  {remoteError && (
                    <div className="p-3 bg-[var(--color-error-muted)] border border-[var(--color-error)]/20 rounded-lg">
                      <p className="text-xs" style={{ color: 'var(--color-error)' }}>
                        {remoteError}
                      </p>
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      onClick={() => setShowRemoteDialog(false)}
                      className="px-4 py-2 text-sm transition-colors cursor-pointer"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleSaveCookieAndConnect}
                      disabled={!tempCookies.trim()}
                      className="flex items-center gap-2 px-4 py-2 bg-[var(--color-success)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg transition-colors cursor-pointer text-white"
                    >
                      <Cloud className="w-4 h-4" />
                      <span>{t('welcome.remoteDialog.connect')}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Connecting State */}
              {isConnecting && (
                <div className="flex items-center justify-center gap-3 py-12">
                  <Loader2 className="w-6 h-6 text-[var(--color-success)] animate-spin" />
                  <span style={{ color: 'var(--color-text-primary)' }}>
                    {t('welcome.remoteDialog.connecting')}
                  </span>
                </div>
              )}

              {/* Error Display */}
              {remoteError && !showCookieSetup && (
                <div className="mb-4 p-4 bg-[var(--color-error-muted)] border border-[var(--color-error)]/20 rounded-lg">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-[var(--color-error)] mt-0.5" />
                    <div>
                      <p className="text-sm" style={{ color: 'var(--color-error)' }}>
                        {remoteError}
                      </p>
                      {remoteError.includes('Cookie') && (
                        <p
                          className="text-xs mt-2"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {t('welcome.remoteDialog.cookieExpired')}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => {
                        setShowCookieSetup(true);
                        setTempServerUrl(
                          compilerSettings.overleaf.serverUrl || 'https://www.overleaf.com'
                        );
                        setTempCookies(compilerSettings.overleaf.cookies || '');
                        setRemoteError(null);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--color-warning-muted)] hover:opacity-90 text-[var(--color-warning)] rounded-lg transition-colors cursor-pointer"
                    >
                      <Settings className="w-3 h-3" />
                      {t('welcome.remoteDialog.reconfigure')}
                    </button>
                    <button
                      onClick={connectAndLoadProjects}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer"
                      style={{
                        background: 'var(--color-bg-tertiary)',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      <RefreshCw className="w-3 h-3" />
                      {t('welcome.remoteDialog.retryConnect')}
                    </button>
                  </div>
                </div>
              )}

              {/* Project List */}
              {isLoggedIn && !isConnecting && (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm" style={{ color: 'var(--color-text-primary)' }}>
                      {isLoadingProjects
                        ? t('welcome.remoteDialog.loadingProjects')
                        : t('welcome.remoteDialog.projectCount', { count: remoteProjects.length })}
                    </span>
                    <button
                      onClick={loadRemoteProjects}
                      disabled={isLoadingProjects}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)] rounded transition-colors cursor-pointer"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      <RefreshCw className={`w-3 h-3 ${isLoadingProjects ? 'animate-spin' : ''}`} />
                      {t('common.refresh')}
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-2 min-h-[200px] max-h-[400px]">
                    {isLoadingProjects ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 text-[var(--color-success)] animate-spin" />
                      </div>
                    ) : remoteProjects.length === 0 ? (
                      <div
                        className="flex flex-col items-center justify-center py-12"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Cloud className="w-12 h-12 mb-3 opacity-50" />
                        <p>{t('welcome.remoteDialog.noProjects')}</p>
                      </div>
                    ) : (
                      remoteProjects.map((project) => (
                        <div
                          key={project.id}
                          onClick={() => setSelectedProject(project)}
                          className="p-4 rounded-lg border cursor-pointer transition-all"
                          style={{
                            background:
                              selectedProject?.id === project.id
                                ? 'var(--color-success-muted)'
                                : 'var(--color-bg-tertiary)',
                            borderColor:
                              selectedProject?.id === project.id
                                ? 'var(--color-success)'
                                : 'var(--color-border)',
                          }}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h3
                                  className="text-sm font-semibold truncate"
                                  style={{ color: 'var(--color-text-primary)' }}
                                >
                                  {project.name}
                                </h3>
                                {selectedProject?.id === project.id && (
                                  <Check className="w-4 h-4 text-[var(--color-success)]" />
                                )}
                              </div>
                              <div
                                className="flex items-center gap-3 mt-1 text-xs"
                                style={{ color: 'var(--color-text-muted)' }}
                              >
                                {project.owner && (
                                  <span>{project.owner.firstName || project.owner.email}</span>
                                )}
                                {project.accessLevel && (
                                  <span
                                    className="px-1.5 py-0.5 rounded"
                                    style={{
                                      backgroundColor:
                                        project.accessLevel === 'owner'
                                          ? 'var(--color-success-muted)'
                                          : project.accessLevel === 'readAndWrite'
                                            ? 'var(--color-info-muted)'
                                            : 'var(--color-bg-tertiary)',
                                      color:
                                        project.accessLevel === 'owner'
                                          ? 'var(--color-success)'
                                          : project.accessLevel === 'readAndWrite'
                                            ? 'var(--color-info)'
                                            : 'var(--color-text-muted)',
                                    }}
                                  >
                                    {project.accessLevel === 'owner'
                                      ? t('welcome.remoteDialog.accessOwner')
                                      : project.accessLevel === 'readAndWrite'
                                        ? t('welcome.remoteDialog.accessReadWrite')
                                        : t('welcome.remoteDialog.accessReadOnly')}
                                  </span>
                                )}
                              </div>
                            </div>
                            <a
                              href={`${compilerSettings.overleaf.serverUrl || 'https://www.overleaf.com'}/project/${project.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded transition-colors"
                              title={t('welcome.remoteDialog.openInBrowser')}
                            >
                              <ExternalLink
                                className="w-4 h-4"
                                style={{ color: 'var(--color-text-muted)' }}
                              />
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div
                    className="flex items-center justify-end gap-3 mt-4 pt-4 border-t"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <button
                      onClick={() => setShowRemoteDialog(false)}
                      className="px-4 py-2 text-sm transition-colors cursor-pointer"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleOpenSelectedProject}
                      disabled={!selectedProject || isConnecting}
                      className="flex items-center gap-2 px-4 py-2 bg-[var(--color-success)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg transition-colors cursor-pointer text-white"
                    >
                      {isConnecting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>{t('welcome.remoteDialog.opening')}</span>
                        </>
                      ) : (
                        <>
                          <FolderOpen className="w-4 h-4" />
                          <span>{t('welcome.remoteDialog.openProject')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
