/**
 * @file CollaborationBootstrapService.ts — unified collaboration bootstrap entry
 * @description Collapses the "resolve binding → OT connect → create project → update settings →
 *   activate scope" pipeline into one service method shared by WelcomeScreen, FileOpenService, etc.
 */

import { api } from '../../api';
import { t } from '../../locales';
import type { FileNode } from '../../types';
import { createLogger } from '../LogService';
import {
  getConversationScopeService,
  getProjectRuntimeContext,
  getSettingsService,
} from './ServiceRegistry';
import { getOTService } from './OTService';

const logger = createLogger('CollaborationBootstrap');
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const DERIVED_PROJECT_DIRS = new Set(['output', 'out', 'dist', 'build', 'target']);

export interface CollaborationBootstrapResult {
  projectId: string;
  projectName: string;
  projectPath: string;
  fileTree: FileNode;
}

function shouldReuseResolvedBinding(projectPath: string, bindingRootPath: string): boolean {
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedBinding = bindingRootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedProject === normalizedBinding) {
    return true;
  }
  if (!normalizedProject.startsWith(`${normalizedBinding}/`)) {
    return false;
  }

  const relative = normalizedProject.slice(normalizedBinding.length + 1);
  const segments = relative.split('/').filter(Boolean);
  return (
    segments.length > 0 &&
    segments.every((segment) => DERIVED_PROJECT_DIRS.has(segment.toLowerCase()))
  );
}

export function clearActiveCollaborationProjectState(): void {
  getProjectRuntimeContext().reset();
}

async function resolveBotUserIdFromIMSettings(): Promise<void> {
  const imSettings = getSettingsService().settings.im;
  if (!imSettings.serverUrl || !imSettings.token) {
    return;
  }

  try {
    const botUserId = await api.im.getBotUserId(imSettings.serverUrl, imSettings.token);
    if (!botUserId) {
      return;
    }
    getProjectRuntimeContext().update({ botUserId });
    await api.ot.setBotUserId(botUserId);
    logger.info(`Bot userId resolved: ${botUserId}`);
  } catch (error) {
    logger.warn(
      `Failed to resolve bot userId (AI diff review unavailable): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Bring a project into collaboration: connect OT → resolve/create binding → persist settings →
 * activate conversation scope.
 *
 * @param projectPath - Local project root path
 * @param fileTree - Local file tree (uploaded on first remote-project creation)
 * @returns Ready-to-use result (projectId + refreshed fileTree), or null when
 *   collaboration is disabled / failed and we fell back to local mode.
 */
export async function ensureCollaboration(
  projectPath: string,
  fileTree: FileNode
): Promise<CollaborationBootstrapResult | null> {
  const settingsService = getSettingsService();
  const settings = settingsService.settings;
  const collab = settings.collaboration;

  if (!collab.enabled || !collab.serverUrl || !collab.token) {
    return null;
  }

  // Collaboration bootstrap with timeout guard
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    ensureCollaborationInner(projectPath, fileTree),
    new Promise<null>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(t('collaboration.bootstrapTimeout', { seconds: BOOTSTRAP_TIMEOUT_MS / 1000 }))
          ),
        BOOTSTRAP_TIMEOUT_MS
      );
    }),
  ])
    .finally(() => {
      clearTimeout(timeoutId);
    })
    .catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`collaboration bootstrap failed, fallback to local: ${msg}`);
      const otService = getOTService();
      otService.resetLocal();
      // OT failure clears only collaboration fields (projectId/fileId); rootPath stays for IM-only mode
      getProjectRuntimeContext().update({ projectId: '', fileId: '' });
      return null;
    });
}

async function ensureCollaborationInner(
  projectPath: string,
  fileTree: FileNode
): Promise<CollaborationBootstrapResult> {
  const settingsService = getSettingsService();
  const collab = settingsService.settings.collaboration;
  const otService = getOTService();

  otService.connect({ baseUrl: collab.serverUrl, token: collab.token });

  const resolved = await api.projectBinding.resolve(projectPath);
  let projectId = '';
  let projectName = '';
  let needCreateRemote = false;

  const reusableBinding =
    resolved?.found &&
    resolved.binding &&
    shouldReuseResolvedBinding(projectPath, resolved.binding.localRootPath);

  if (reusableBinding && resolved.binding) {
    projectId = resolved.binding.remoteProjectId;
    projectName = resolved.binding.projectName;

    // Verify the remote project is still reachable (server swap, deletion, etc.)
    try {
      await otService.getProjectTree(projectPath, projectId);
    } catch (verifyError: unknown) {
      const errorLike = verifyError as {
        message?: unknown;
        status?: unknown;
        statusCode?: unknown;
      };
      const msg = String(errorLike.message || '');
      const statusCode =
        typeof errorLike.status === 'number'
          ? errorLike.status
          : typeof errorLike.statusCode === 'number'
            ? errorLike.statusCode
            : undefined;
      const isGone =
        statusCode === 403 ||
        statusCode === 404 ||
        msg.includes('403') ||
        msg.includes('404') ||
        msg.includes('Forbidden') ||
        msg.includes('Not Found');
      if (isGone) {
        logger.warn(`Bound remote project unreachable; will recreate: ${projectId} ${msg}`);
        needCreateRemote = true;
      } else {
        throw verifyError;
      }
    }
  } else {
    if (resolved?.found && resolved.binding) {
      logger.info(
        `Ignoring ancestor binding; creating a standalone collaboration project for: ${projectPath} (binding=${resolved.binding.localRootPath})`
      );
    }
    needCreateRemote = true;
  }

  if (needCreateRemote) {
    const snapshot = await otService.openLocalProject(projectPath, fileTree);
    projectId = snapshot.project.id;
    projectName = snapshot.project.name || projectPath.split(/[\\/]/).pop() || projectPath;
    await api.projectBinding.ensureBindingFromBootstrap({
      localRootPath: projectPath,
      remoteProjectId: projectId,
      projectName,
      backend: 'scipen-ot',
    });
    logger.info(`Created new remote project: ${projectId}`);
  }

  getProjectRuntimeContext().update({ rootPath: projectPath, projectId, fileId: '' });

  await resolveBotUserIdFromIMSettings();

  const refreshedTree = await otService.getProjectTree(projectPath, projectId);

  logger.info(`Collaboration ready: ${projectPath}`);

  return {
    projectId,
    projectName,
    projectPath,
    fileTree: refreshedTree as FileNode,
  };
}

/**
 * Activate the project's conversation scope (OpenClaw binding).
 * Decoupled from ensureCollaboration — a local session may still need activation
 * even when collaboration failed.
 *
 * @param projectPath - Local project path
 * @param projectId - Collaboration project id returned by ensureCollaboration; pass null on failure.
 *                    Must be passed explicitly — do not read from the settings side channel — to
 *                    avoid ordering races.
 */
export async function activateProjectConversationScope(
  projectPath: string,
  projectId: string | null
): Promise<void> {
  const settings = getSettingsService().settings;
  await getConversationScopeService().activateProjectScope({
    projectId,
    localRootPath: projectPath,
    workspaceId: settings.assistant.openclaw.workspaceId || null,
    title: projectPath.split(/[\\/]/).pop() || 'SciPen Project',
    createIfMissing: true,
  });
  await resolveBotUserIdFromIMSettings();
}
