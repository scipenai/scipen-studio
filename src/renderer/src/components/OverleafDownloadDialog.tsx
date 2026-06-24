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
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
  const titleId = useId();
  const serverUrlId = useId();
  const cookiesId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

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

  const getFocusableElements = useCallback(() => {
    if (!dialogRef.current) return [];

    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
    );
  }, []);

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [getFocusableElements, onClose]
  );

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

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    window.requestAnimationFrame(() => {
      const [firstFocusable] = getFocusableElements();
      (firstFocusable ?? dialogRef.current)?.focus();
    });

    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [getFocusableElements, open]);

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
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={dialogRef}
            tabIndex={-1}
            className="mx-4 flex max-h-[82vh] w-full max-w-3xl flex-col rounded-[28px] border p-6 shadow-[0_32px_90px_rgba(15,23,42,0.18)]"
            style={{
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(250,249,245,0.95) 100%)',
              borderColor: 'rgba(148,163,184,0.2)',
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleDialogKeyDown}
          >
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-2xl"
                  style={{
                    background: 'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)',
                    color: 'var(--color-overleaf-primary)',
                  }}
                >
                  <Cloud className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h2
                    id={titleId}
                    className="text-lg font-semibold text-[var(--color-text-primary)]"
                  >
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
                aria-label={t('common.close')}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-2xl border focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                style={{
                  background: 'rgba(255,255,255,0.84)',
                  borderColor: 'rgba(148,163,184,0.18)',
                  color: 'var(--color-text-muted)',
                }}
              >
                <X className="h-4.5 w-4.5" aria-hidden="true" />
              </button>
            </div>

            {showCookieSetup && !isConnecting && (
              <div className="space-y-4 overflow-y-auto">
                <div
                  className="rounded-[20px] border p-4"
                  style={{
                    background: 'color-mix(in srgb, var(--color-overleaf-primary) 6%, transparent)',
                    borderColor:
                      'color-mix(in srgb, var(--color-overleaf-primary) 14%, transparent)',
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
                  <label
                    htmlFor={serverUrlId}
                    className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
                  >
                    {t('welcome.remoteDialog.serverUrl')}
                  </label>
                  <input
                    id={serverUrlId}
                    type="text"
                    value={tempServerUrl}
                    onChange={(event) => setTempServerUrl(event.target.value)}
                    placeholder="https://www.overleaf.com"
                    className="w-full rounded-2xl border px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
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
                  <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
                    <label htmlFor={cookiesId}>{t('welcome.remoteDialog.cookies')}</label>
                    <span className="text-[var(--color-error)]" aria-hidden="true">
                      *
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      id={cookiesId}
                      type={showCookies ? 'text' : 'password'}
                      value={tempCookies}
                      onChange={(event) => setTempCookies(event.target.value)}
                      placeholder="overleaf_session2=..."
                      className="w-full rounded-2xl border px-3 py-3 pr-10 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                      style={{
                        background: 'rgba(255,255,255,0.84)',
                        borderColor: 'rgba(148,163,184,0.18)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCookies(!showCookies)}
                      aria-label={
                        showCookies
                          ? t('welcome.remoteDialog.hideCookies')
                          : t('welcome.remoteDialog.showCookies')
                      }
                      aria-pressed={showCookies}
                      className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-xl p-1.5 hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    >
                      {showCookies ? (
                        <EyeOff
                          className="h-4 w-4 text-[var(--color-text-muted)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <Eye
                          className="h-4 w-4 text-[var(--color-text-muted)]"
                          aria-hidden="true"
                        />
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
                    className="cursor-pointer rounded-xl px-4 py-2 text-sm text-[var(--color-text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleSaveCookieAndConnect();
                    }}
                    disabled={!tempCookies.trim()}
                    className="flex cursor-pointer items-center gap-2 rounded-2xl px-4 py-2 text-sm text-white transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--color-overleaf-gradient)' }}
                  >
                    <Cloud className="h-4 w-4" aria-hidden="true" />
                    {t('welcome.remoteDialog.connect')}
                  </button>
                </div>
              </div>
            )}

            {isConnecting && (
              <div className="flex items-center justify-center gap-3 py-12 text-[var(--color-text-primary)]">
                <Loader2
                  className="h-6 w-6 animate-spin text-[var(--color-overleaf-primary)]"
                  aria-hidden="true"
                />
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
                  <X className="mt-0.5 h-5 w-5 text-[var(--color-error)]" aria-hidden="true" />
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
                    className="flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    style={{
                      background:
                        'color-mix(in srgb, var(--color-overleaf-primary) 8%, transparent)',
                      color: 'var(--color-overleaf-primary)',
                    }}
                  >
                    <Settings className="h-3 w-3" aria-hidden="true" />
                    {t('welcome.remoteDialog.reconfigure')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void connectAndLoadProjects();
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-2xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    style={{
                      background: 'rgba(255,255,255,0.84)',
                      borderColor: 'rgba(148,163,184,0.18)',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
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
                    className="flex cursor-pointer items-center gap-1.5 rounded-xl px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${isLoadingProjects ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    {t('common.refresh')}
                  </button>
                </div>

                <div className="min-h-[200px] max-h-[420px] flex-1 space-y-2 overflow-y-auto">
                  {isLoadingProjects ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2
                        className="h-6 w-6 animate-spin text-[var(--color-overleaf-primary)]"
                        aria-hidden="true"
                      />
                    </div>
                  ) : remoteProjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
                      <Cloud className="mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
                      <p>{t('welcome.remoteDialog.noProjects')}</p>
                    </div>
                  ) : (
                    remoteProjects.map((project) => (
                      <div
                        key={project.id}
                        onClick={() => setSelectedProject(project)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedProject(project);
                          }
                        }}
                        className="cursor-pointer rounded-[20px] border p-4 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                        role="button"
                        tabIndex={0}
                        aria-pressed={selectedProject?.id === project.id}
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
                                <Check
                                  className="h-4 w-4 text-[var(--color-overleaf-primary)]"
                                  aria-hidden="true"
                                />
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
                            className="cursor-pointer rounded-xl p-1.5 transition-colors hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                            title={t('welcome.remoteDialog.openInBrowser')}
                            aria-label={t('welcome.remoteDialog.openInBrowser')}
                          >
                            <ExternalLink
                              className="h-4 w-4 text-[var(--color-text-muted)]"
                              aria-hidden="true"
                            />
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
                    className="cursor-pointer rounded-xl px-4 py-2 text-sm text-[var(--color-text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDownloadAndOpen();
                    }}
                    disabled={!selectedProject || isConnecting}
                    className="flex cursor-pointer items-center gap-2 rounded-2xl px-4 py-2 text-sm text-white transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--color-overleaf-gradient)' }}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('welcome.remoteDialog.opening')}
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4" aria-hidden="true" />
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
