/**
 * @file OverleafDownloadDialog.tsx - Overleaf project download dialog
 * @description Log in to Overleaf -> browse project list -> download to disk and open
 * (local-first mode).
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../locales';
import { getEditorService, getSettingsService, useCompilerSettings } from '../services/core';
import { bootstrapProject } from '../services/core/FileOpenService';
import type { FileNode } from '../types';
import { formatTimeAgo } from '../utils';
import { cleanupStaleTabs, findFileNodeId, resetWorkspaceToChat } from './welcomeScreenHelpers';

interface OverleafProject {
  id: string;
  name: string;
  lastUpdated?: string;
  owner?: { id: string; email: string; firstName?: string; lastName?: string };
  accessLevel?: 'owner' | 'readAndWrite' | 'readOnly' | string;
  compiler?: string;
}

interface OverleafDownloadDialogProps {
  open: boolean;
  onClose: () => void;
}

export const OverleafDownloadDialog: React.FC<OverleafDownloadDialogProps> = ({
  open,
  onClose,
}) => {
  const compilerSettings = useCompilerSettings();
  const { t } = useTranslation();

  const [remoteProjects, setRemoteProjects] = useState<OverleafProject[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedProject, setSelectedProject] = useState<OverleafProject | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showCookieSetup, setShowCookieSetup] = useState(false);
  const [tempServerUrl, setTempServerUrl] = useState('');
  const [tempCookies, setTempCookies] = useState('');
  const [showCookies, setShowCookies] = useState(false);

  async function loadRemoteProjects() {
    setIsLoadingProjects(true);
    setRemoteError(null);
    try {
      const result = await api.overleaf.getProjects();
      if (!result) throw new Error(t('common.error'));
      setRemoteProjects(
        result.map((project) => ({
          ...project,
          lastUpdated: project.lastUpdated || new Date().toISOString(),
        }))
      );
    } catch (error) {
      console.error('Failed to load project list:', error);
      setRemoteError(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setIsLoadingProjects(false);
    }
  }

  async function connectAndLoadProjects(overrides?: { serverUrl?: string; cookies?: string }) {
    const serverUrl = overrides?.serverUrl || compilerSettings.overleaf.serverUrl;
    const cookies = overrides?.cookies || compilerSettings.overleaf.cookies;
    if (!cookies) {
      setRemoteError(t('welcome.remoteDialog.cookiesRequired'));
      return;
    }
    setIsConnecting(true);
    setRemoteError(null);
    try {
      const loginResult = await api.overleaf.login({
        serverUrl: serverUrl || 'https://www.overleaf.com',
        cookies,
      });
      if (!loginResult?.success) throw new Error(loginResult?.message || t('common.error'));
      setIsLoggedIn(true);
      setIsConnecting(false);
      await loadRemoteProjects();
    } catch (error) {
      console.error('Failed to connect to Overleaf:', error);
      setRemoteError(error instanceof Error ? error.message : t('common.error'));
      setIsConnecting(false);
      setIsLoggedIn(false);
    }
  }

  async function handleSaveCookieAndConnect() {
    if (!tempCookies.trim()) {
      setRemoteError(t('welcome.remoteDialog.cookiesRequired'));
      return;
    }
    const freshServerUrl = tempServerUrl || 'https://www.overleaf.com';
    const freshCookies = tempCookies.trim();
    getSettingsService().updateCompiler({
      overleaf: {
        ...compilerSettings.overleaf,
        serverUrl: freshServerUrl,
        cookies: freshCookies,
      },
    });
    setShowCookieSetup(false);
    setRemoteError(null);
    // Pass fresh values directly; do not rely on the not-yet-updated render closure.
    await connectAndLoadProjects({ serverUrl: freshServerUrl, cookies: freshCookies });
  }

  /** Download project locally -> openByPath -> bootstrapProject -> open rootDoc. */
  async function handleDownloadAndOpen() {
    if (!selectedProject) return;
    setIsConnecting(true);
    setRemoteError(null);
    try {
      const downloadResult = await api.overleaf.downloadProject(
        selectedProject.id,
        selectedProject.name
      );
      if (!downloadResult.success || !downloadResult.localPath || !downloadResult.meta) {
        throw new Error(downloadResult.error || 'Failed to download project');
      }

      const localPath = downloadResult.localPath;
      const docIdMap = downloadResult.meta.docIdMap;

      const openResult = await api.project.openByPath(localPath);
      if (!openResult) {
        throw new Error('Failed to open project');
      }

      // Fetch rootDoc_id so we can auto-open the main file.
      const detailsResult = await api.overleaf.getProjectDetails(selectedProject.id);
      const rootDocId = (detailsResult?.details as { rootDoc_id?: string } | undefined)?.rootDoc_id;

      // Restore Overleaf connection info (without changing the compile engine).
      getSettingsService().updateCompiler({
        overleaf: {
          ...compilerSettings.overleaf,
          projectId: selectedProject.id,
          serverUrl: downloadResult.meta.serverUrl,
        },
      });

      const synced = await bootstrapProject(
        openResult.projectPath,
        openResult.fileTree as FileNode,
        {
          overleafOverride: {
            overleafProjectId: selectedProject.id,
            overleafDocMap: docIdMap,
            overleafServerUrl: downloadResult.meta.serverUrl,
          },
        }
      );

      resetWorkspaceToChat();
      cleanupStaleTabs(synced.projectPath);

      // Auto-open rootDoc.
      if (rootDocId) {
        const rootDocRelPath = Object.entries(docIdMap).find(([, id]) => id === rootDocId)?.[0];
        if (rootDocRelPath) {
          const fullPath = `${synced.projectPath}/${rootDocRelPath}`;
          const docFileName = rootDocRelPath.split('/').pop() || 'main.tex';
          const otFileId = findFileNodeId(synced.fileTree as FileNode, fullPath);
          const fileContent = downloadResult.files?.find(
            (f) => f.file_path === rootDocRelPath
          )?.content;
          if (fileContent !== undefined) {
            getEditorService().addTab({
              path: fullPath,
              name: docFileName,
              content: fileContent,
              isDirty: false,
              language: 'latex',
              _id: otFileId,
            });
          }
        }
      }

      onClose();
    } catch (error) {
      console.error('Failed to download project:', error);
      setRemoteError(error instanceof Error ? error.message : t('welcome.openProjectFailed'));
    } finally {
      setIsConnecting(false);
    }
  }

  function initDialog() {
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
    void connectAndLoadProjects();
  }

  // Auto-initialize when the dialog opens. Don't rely on onAnimationStart since it may be
  // skipped under reduced-motion preferences.
  useEffect(() => {
    if (open) initDialog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
          style={{ background: 'var(--color-backdrop)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            className="mx-4 flex max-h-[82vh] w-full max-w-3xl flex-col rounded-[28px] border p-6 shadow-[0_32px_90px_rgba(15,23,42,0.18)]"
            style={{
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(250,249,245,0.95) 100%)',
              borderColor: 'rgba(148,163,184,0.2)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-2xl"
                  style={{ background: 'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)', color: 'var(--color-overleaf-primary)' }}
                >
                  <Cloud className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                    {t('welcome.remoteDialog.title')}
                  </h2>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t('welcome.remoteDialog.subtitle')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border"
                style={{
                  background: 'rgba(255,255,255,0.84)',
                  borderColor: 'rgba(148,163,184,0.18)',
                  color: 'var(--color-text-muted)',
                }}
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {showCookieSetup && !isConnecting && (
              <div className="space-y-4 overflow-y-auto">
                <div
                  className="rounded-[20px] border p-4"
                  style={{
                    background: 'color-mix(in srgb, var(--color-overleaf-primary) 6%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--color-overleaf-primary) 14%, transparent)',
                  }}
                >
                  <p className="text-sm font-medium text-[var(--color-overleaf-primary)]">
                    {t('welcome.remoteDialog.configRequired')}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    {t('welcome.remoteDialog.configHint')}
                  </p>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                    {t('welcome.remoteDialog.serverUrl')}
                  </label>
                  <input
                    type="text"
                    value={tempServerUrl}
                    onChange={(event) => setTempServerUrl(event.target.value)}
                    placeholder="https://www.overleaf.com"
                    className="w-full rounded-2xl border px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none"
                    style={{
                      background: 'rgba(255,255,255,0.84)',
                      borderColor: 'rgba(148,163,184,0.18)',
                    }}
                  />
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {t('welcome.remoteDialog.serverUrlHint')}
                  </p>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                    {t('welcome.remoteDialog.cookies')}{' '}
                    <span className="text-[var(--color-error)]">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showCookies ? 'text' : 'password'}
                      value={tempCookies}
                      onChange={(event) => setTempCookies(event.target.value)}
                      placeholder="overleaf_session2=..."
                      className="w-full rounded-2xl border px-3 py-3 pr-10 text-sm text-[var(--color-text-primary)] outline-none"
                      style={{
                        background: 'rgba(255,255,255,0.84)',
                        borderColor: 'rgba(148,163,184,0.18)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCookies(!showCookies)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xl p-1.5 hover:bg-[var(--color-bg-hover)]"
                    >
                      {showCookies ? (
                        <EyeOff className="h-4 w-4 text-[var(--color-text-muted)]" />
                      ) : (
                        <Eye className="h-4 w-4 text-[var(--color-text-muted)]" />
                      )}
                    </button>
                  </div>
                </div>

                {remoteError && (
                  <div
                    className="rounded-[20px] border p-3"
                    style={{
                      background: 'color-mix(in srgb, var(--color-error) 8%, transparent)',
                      borderColor: 'color-mix(in srgb, var(--color-error) 16%, transparent)',
                    }}
                  >
                    <p className="text-xs text-[var(--color-error)]">{remoteError}</p>
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-[var(--color-text-secondary)]"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleSaveCookieAndConnect();
                    }}
                    disabled={!tempCookies.trim()}
                    className="flex items-center gap-2 rounded-2xl px-4 py-2 text-sm text-white transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--color-overleaf-gradient)' }}
                  >
                    <Cloud className="h-4 w-4" />
                    {t('welcome.remoteDialog.connect')}
                  </button>
                </div>
              </div>
            )}

            {isConnecting && (
              <div className="flex items-center justify-center gap-3 py-12 text-[var(--color-text-primary)]">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--color-overleaf-primary)]" />
                {t('welcome.remoteDialog.connecting')}
              </div>
            )}

            {remoteError && !showCookieSetup && (
              <div
                className="mb-4 rounded-[20px] border p-4"
                style={{
                  background: 'color-mix(in srgb, var(--color-error) 8%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--color-error) 16%, transparent)',
                }}
              >
                <div className="flex items-start gap-3">
                  <X className="mt-0.5 h-5 w-5 text-[var(--color-error)]" />
                  <div>
                    <p className="text-sm text-[var(--color-error)]">{remoteError}</p>
                    {remoteError.includes('Cookie') && (
                      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
                        {t('welcome.remoteDialog.cookieExpired')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCookieSetup(true);
                      setTempServerUrl(
                        compilerSettings.overleaf.serverUrl || 'https://www.overleaf.com'
                      );
                      setTempCookies(compilerSettings.overleaf.cookies || '');
                      setRemoteError(null);
                    }}
                    className="flex items-center gap-2 rounded-2xl px-3 py-1.5 text-xs font-medium"
                    style={{
                      background: 'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)',
                      color: 'var(--color-overleaf-primary)',
                    }}
                  >
                    <Settings className="h-3 w-3" />
                    {t('welcome.remoteDialog.reconfigure')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void connectAndLoadProjects();
                    }}
                    className="flex items-center gap-2 rounded-2xl border px-3 py-1.5 text-xs font-medium"
                    style={{
                      background: 'rgba(255,255,255,0.84)',
                      borderColor: 'rgba(148,163,184,0.18)',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    <RefreshCw className="h-3 w-3" />
                    {t('welcome.remoteDialog.retryConnect')}
                  </button>
                </div>
              </div>
            )}

            {isLoggedIn && !isConnecting && (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm text-[var(--color-text-primary)]">
                    {isLoadingProjects
                      ? t('welcome.remoteDialog.loadingProjects')
                      : t('welcome.remoteDialog.projectCount', { count: remoteProjects.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void loadRemoteProjects();
                    }}
                    disabled={isLoadingProjects}
                    className="flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <RefreshCw className={`h-3 w-3 ${isLoadingProjects ? 'animate-spin' : ''}`} />
                    {t('common.refresh')}
                  </button>
                </div>

                <div className="min-h-[200px] max-h-[420px] flex-1 space-y-2 overflow-y-auto">
                  {isLoadingProjects ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin text-[var(--color-overleaf-primary)]" />
                    </div>
                  ) : remoteProjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
                      <Cloud className="mb-3 h-12 w-12 opacity-50" />
                      <p>{t('welcome.remoteDialog.noProjects')}</p>
                    </div>
                  ) : (
                    remoteProjects.map((project) => (
                      <div
                        key={project.id}
                        onClick={() => setSelectedProject(project)}
                        className="cursor-pointer rounded-[20px] border p-4 transition-all"
                        style={{
                          background:
                            selectedProject?.id === project.id
                              ? 'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)'
                              : 'rgba(255,255,255,0.78)',
                          borderColor:
                            selectedProject?.id === project.id
                              ? 'color-mix(in srgb, var(--color-overleaf-primary) 18%, transparent)'
                              : 'rgba(148,163,184,0.16)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                                {project.name}
                              </h3>
                              {selectedProject?.id === project.id && (
                                <Check className="h-4 w-4 text-[var(--color-overleaf-primary)]" />
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                              {project.owner && (
                                <span>{project.owner.firstName || project.owner.email}</span>
                              )}
                              {project.lastUpdated && (
                                <span>
                                  {t('welcome.remoteDialog.updatedAt', {
                                    time: formatTimeAgo(project.lastUpdated),
                                  })}
                                </span>
                              )}
                              {project.accessLevel && (
                                <span
                                  className="rounded-full px-2 py-0.5"
                                  style={{
                                    backgroundColor:
                                      project.accessLevel === 'owner'
                                        ? 'color-mix(in srgb, var(--color-success) 8%, transparent)'
                                        : project.accessLevel === 'readAndWrite'
                                          ? 'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)'
                                          : 'rgba(15,23,42,0.05)',
                                    color:
                                      project.accessLevel === 'owner'
                                        ? 'var(--color-success)'
                                        : project.accessLevel === 'readAndWrite'
                                          ? 'var(--color-overleaf-primary)'
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
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-xl p-1.5 transition-colors hover:bg-[var(--color-bg-hover)]"
                            title={t('welcome.remoteDialog.openInBrowser')}
                          >
                            <ExternalLink className="h-4 w-4 text-[var(--color-text-muted)]" />
                          </a>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div
                  className="mt-4 flex items-center justify-end gap-3 border-t pt-4"
                  style={{ borderColor: 'rgba(148,163,184,0.16)' }}
                >
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-[var(--color-text-secondary)]"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDownloadAndOpen();
                    }}
                    disabled={!selectedProject || isConnecting}
                    className="flex items-center gap-2 rounded-2xl px-4 py-2 text-sm text-white transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--color-overleaf-gradient)' }}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('welcome.remoteDialog.opening')}
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4" />
                        {t('welcome.remoteDialog.openProject')}
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
  );
};
