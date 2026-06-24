/**
 * @file overleaf-sync-helper.ts — Shared post-save sync logic for Overleaf local-first mode.
 * @description Extracted from useGlobalShortcuts and editorSetup to eliminate a DRY violation.
 */

import { api } from '../api';
import { resolveOverleafFolderId } from '../components/file-explorer/utils/overleaf-sync';
import { t } from '../locales';
import {
  getEditorService,
  getOverleafLiveService,
  getProjectRuntimeContext,
} from '../services/core';
import { createLogger } from '../services/LogService';
import { isSameOrChildPath } from './pathComparison';

const logger = createLogger('OverleafSyncHelper');

interface SyncAfterSaveParams {
  /** Absolute path of the saved file. */
  filePath: string;
  /** File content that was saved. */
  content: string;
  /** Display name of the file. */
  fileName: string;
  /** Callback used to emit log lines. */
  addLog: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void;
}

export interface OverleafNewFileSyncResult {
  success: boolean;
  skipped?: boolean;
  relativePath?: string;
  error?: string;
}

/**
 * Push a saved file to Overleaf asynchronously (never blocks the local save).
 * Resolves or creates the docId on demand and pops the conflict dialog when required.
 */
export function triggerOverleafSyncAfterSave(params: SyncAfterSaveParams): void {
  const rt = getProjectRuntimeContext();
  if (!rt.overleafProjectId) return;

  const rootPath = rt.rootPath;
  if (!rootPath) return;
  const normalizedFile = params.filePath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/');
  if (!isSameOrChildPath(normalizedFile, normalizedRoot)) return;

  const relativePath = normalizedFile.slice(normalizedRoot.length + 1);
  const docIdMap = rt.overleafDocMap;

  api.overleaf
    .syncFileByPath(rt.overleafProjectId, relativePath, params.content, rootPath, docIdMap)
    .then(async (syncResult) => {
      // New docId → patch a single entry atomically in the settings map; avoid a full read/write cycle.
      if (syncResult.newDocId) {
        getProjectRuntimeContext().patchOverleafDocMapEntry(relativePath, syncResult.newDocId);
      }

      if (syncResult.status === 'synced') {
        params.addLog('info', t('overleaf.syncSuccess', { fileName: params.fileName }));
      } else if (syncResult.status === 'conflict') {
        await handleConflict(params, rt.overleafProjectId, relativePath, docIdMap, syncResult);
      } else if (syncResult.status === 'error') {
        params.addLog('warning', t('overleaf.syncFailed', { error: syncResult.error || '' }));
      }
    })
    .catch((err) => {
      logger.warn('Overleaf sync failed:', err);
    });
}

/** Known binary extensions — anything outside this set is treated as text. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
  '.webp',
  '.avif',
  '.svg',
  '.eps',
  '.ps',
  '.pdf',
  '.dvi',
  '.zip',
  '.gz',
  '.tar',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.avi',
  '.mov',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.obj',
  '.wasm',
  '.db',
  '.sqlite',
  '.sqlite3',
]);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * Sync a freshly created local file (or folder) to Overleaf.
 * - Text files (non-binary extension, or no extension) → syncFileByPath, doc channel.
 * - Binary files (matched by BINARY_EXTENSIONS) → uploadFile, fileRef channel.
 * - Folders → createEntity(folder) followed by a recursive sync of the contents.
 */
export async function triggerOverleafNewFileSync(
  localPath: string,
  isDirectory = false
): Promise<OverleafNewFileSyncResult> {
  const rt = getProjectRuntimeContext();
  if (!rt.overleafProjectId) {
    return { success: true, skipped: true };
  }

  const rootPath = rt.rootPath;
  if (!rootPath || !isSameOrChildPath(localPath, rootPath)) {
    return { success: true, skipped: true };
  }

  return await syncNewEntry(rt.overleafProjectId, rootPath, localPath, isDirectory);
}

async function syncNewEntry(
  projectId: string,
  rootPath: string,
  localPath: string,
  isDirectory: boolean,
  parentFolderIdOverride?: string
): Promise<OverleafNewFileSyncResult> {
  const normalizedLocal = localPath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/');
  const relativePath = normalizedLocal.slice(normalizedRoot.length + 1);
  const fileName = relativePath.split('/').pop() || '';

  try {
    // Prefer the caller-supplied parent folder id (recursion); otherwise resolve it from the project tree.
    let parentFolderId = parentFolderIdOverride;
    if (!parentFolderId) {
      const parentRelPath = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : '';
      parentFolderId = (await resolveOverleafFolderId(projectId, parentRelPath)) ?? undefined;
      if (!parentFolderId) {
        const error = `Cannot resolve Overleaf folder for: ${parentRelPath || '(root)'}`;
        logger.warn(error);
        return { success: false, relativePath, error };
      }
    }

    if (isDirectory) {
      const result = await getOverleafLiveService().createEntity({
        projectId,
        entityType: 'folder',
        parentFolderId,
        name: fileName,
      });
      if (!result.success) {
        const error = result.error || `Failed to create Overleaf folder: ${relativePath}`;
        logger.warn(`Failed to create Overleaf folder: ${relativePath}`, result.error);
        return { success: false, relativePath, error };
      }
      logger.info(`Folder created on Overleaf: ${relativePath}`);
      // Use the returned entityId as the parent for children directly; avoids a cache race.
      const newFolderId = result.entityId;
      const children = await api.file.resolveChildren(localPath);
      if (!children?.success) {
        return {
          success: false,
          relativePath,
          error: children?.error || `Failed to enumerate folder children: ${relativePath}`,
        };
      }
      if (children.children && newFolderId) {
        const childErrors: string[] = [];
        for (const child of children.children) {
          const childResult = await syncNewEntry(
            projectId,
            rootPath,
            child.path,
            child.type === 'directory',
            newFolderId
          );
          if (!childResult.success && !childResult.skipped) {
            childErrors.push(childResult.error || childResult.relativePath || child.path);
          }
        }
        if (childErrors.length > 0) {
          return { success: false, relativePath, error: childErrors.join('; ') };
        }
      }
      return { success: true, relativePath };
    }

    const ext = fileName.includes('.')
      ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
      : '';
    const isBinary = ext !== '' && BINARY_EXTENSIONS.has(ext);

    if (!isBinary) {
      // Text file (including no-extension files) → syncFileByPath creates a doc.
      const result = await api.file.read(localPath);
      if (!result || result.content === undefined || result.content === null) {
        return {
          success: false,
          relativePath,
          error: `Failed to read local text file: ${relativePath}`,
        };
      }
      const syncResult = await api.overleaf.syncFileByPath(
        projectId,
        relativePath,
        result.content,
        rootPath,
        getProjectRuntimeContext().overleafDocMap as Record<string, string>
      );
      if (syncResult?.newDocId) {
        getProjectRuntimeContext().patchOverleafDocMapEntry(relativePath, syncResult.newDocId);
      }
      if (syncResult.status !== 'synced') {
        return {
          success: false,
          relativePath,
          error: syncResult.error || `Failed to sync text file: ${relativePath}`,
        };
      }
      logger.info(`Text file synced to Overleaf: ${relativePath}`);
      return { success: true, relativePath };
    } else {
      // Binary file → uploadFile creates a fileRef.
      const buffer = await api.file.readBinary(localPath);
      if (!buffer) {
        return {
          success: false,
          relativePath,
          error: `Failed to read local binary file: ${relativePath}`,
        };
      }
      const mimeType = MIME_MAP[ext] || 'application/octet-stream';
      const uploadResult = await getOverleafLiveService().uploadFile({
        projectId,
        parentFolderId,
        fileName,
        mimeType,
        data: new Uint8Array(buffer),
      });
      if (!uploadResult.success) {
        return {
          success: false,
          relativePath,
          error: uploadResult.error || `Failed to upload binary file: ${relativePath}`,
        };
      }
      logger.info(`Binary file uploaded to Overleaf: ${relativePath}`);
      return { success: true, relativePath };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to sync to Overleaf: ${relativePath}`, err);
    return { success: false, relativePath, error };
  }
}

/** Show the conflict resolution dialog and apply the user's choice. */
async function handleConflict(
  params: SyncAfterSaveParams,
  overleafProjectId: string,
  relativePath: string,
  docIdMap: Record<string, string>,
  syncResult: { remoteContent?: string; newDocId?: string }
): Promise<void> {
  const keepLocal = await api.dialog.confirm(
    t('overleaf.conflictQuestion', { fileName: params.fileName }),
    t('overleaf.conflictTitle')
  );

  const rootPath = getProjectRuntimeContext().rootPath;
  const baseCachePath = `${rootPath}/.overleaf/base-cache/${relativePath.replace(/[\\/]/g, '_')}`;

  if (keepLocal && syncResult.remoteContent !== undefined) {
    // Keep local: refresh base-cache with the remote snapshot, then retry the push.
    await api.file.write(baseCachePath, syncResult.remoteContent);
    const docId = docIdMap[relativePath] || syncResult.newDocId || '';
    if (docId) {
      const retryResult = await api.overleaf.syncFile(
        overleafProjectId,
        docId,
        params.content,
        baseCachePath
      );
      params.addLog(
        retryResult.status === 'synced' ? 'info' : 'warning',
        retryResult.status === 'synced'
          ? t('overleaf.forceSyncSuccess', { fileName: params.fileName })
          : t('overleaf.forceSyncFailed', { fileName: params.fileName })
      );
    }
  } else if (!keepLocal && syncResult.remoteContent !== undefined) {
    // Keep remote: overwrite the local file and base-cache, then refresh the editor.
    await api.file.write(params.filePath, syncResult.remoteContent);
    await api.file.write(baseCachePath, syncResult.remoteContent);
    getEditorService().setContentFromExternal(params.filePath, syncResult.remoteContent);
    getEditorService().markClean(params.filePath);
    params.addLog('info', t('overleaf.versionRestored', { fileName: params.fileName }));
  }
}
