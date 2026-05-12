/**
 * @file overleaf-sync.ts - Overleaf Local-First sync helper functions
 * @description Shared utilities for syncing file operations (create/rename/delete/move) to Overleaf.
 * Used by both command-driven and context-menu-driven file operations.
 */

import type {
  OverleafLiveRenameEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveCreateEntityParams,
} from '../../../../../../shared/ipc/overleaf-contract';
import { api, overleafLive } from '../../../api';
import { getProjectRuntimeContext } from '../../../services/core';

interface OverleafNamedEntity {
  _id?: string;
  id?: string;
  name: string;
}

interface OverleafFolderEntity extends OverleafNamedEntity {
  folders?: OverleafFolderEntity[];
  docs?: OverleafNamedEntity[];
  fileRefs?: OverleafNamedEntity[];
}

// ====== Overleaf Sync Helpers ======

/** Return the Overleaf local-first context (null for non-Overleaf projects). */
export function getOverleafSyncContext(): {
  projectId: string;
  docMap: Record<string, string>;
  rootPath: string;
} | null {
  const rt = getProjectRuntimeContext();
  if (!rt.overleafProjectId || !rt.rootPath) return null;
  return {
    projectId: rt.overleafProjectId,
    docMap: rt.overleafDocMap as Record<string, string>,
    rootPath: rt.rootPath.replace(/\\/g, '/'),
  };
}

export async function persistOverleafDocMap(
  localRoot: string,
  docMap: Record<string, string>,
  addLog?: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void
): Promise<boolean> {
  try {
    await api.overleaf.updateDocIdMap(localRoot, docMap);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog?.('warning', `Failed to persist Overleaf docMap: ${message}`);
    return false;
  }
}

/** Compute a path relative to the project root. */
export function toRelativePath(absolutePath: string, rootPath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/');
  if (normalized === normalizedRoot) {
    return '';
  }
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}

/** Look up a folder ID in the Overleaf project tree by path segments. */
export async function resolveOverleafFolderId(
  projectId: string,
  folderRelPath: string
): Promise<string | null> {
  const result = await api.overleaf.getProjectDetails(projectId);
  if (!result?.success || !result.details) return null;
  const rootFolder = (result.details.rootFolder as OverleafFolderEntity[] | undefined)?.[0];
  if (!rootFolder) return null;
  if (!folderRelPath) return rootFolder._id ?? rootFolder.id ?? null;
  const parts = folderRelPath.split('/').filter(Boolean);
  let current: OverleafFolderEntity = rootFolder;
  for (const part of parts) {
    const sub = (current.folders ?? []).find((folder) => folder.name === part);
    if (!sub) return null;
    current = sub;
  }
  return current._id ?? null;
}

/** Read an Overleaf entity ID from either _id or id (supports both field names). */
function getEntityId(entity: { _id?: string; id?: string } | null | undefined): string {
  return entity?._id || entity?.id || '';
}

/**
 * Look up any entity's ID (doc / fileRef / folder) in the Overleaf project tree by relative path.
 * More general than resolveOverleafFolderId, which only resolves folders.
 */
/** Resolution result carrying both the entity ID and its real Overleaf type (doc/file/folder). */
export interface ResolvedOverleafEntity {
  id: string;
  type: 'doc' | 'file' | 'folder';
}

/**
 * Look up any entity in the Overleaf project tree by relative path and return its ID and real type.
 * doc and fileRef are distinct Overleaf entity types — passing the wrong one causes the operation to fail.
 */
export async function resolveOverleafEntity(
  projectId: string,
  entityRelPath: string,
  entityType?: 'doc' | 'file' | 'folder'
): Promise<ResolvedOverleafEntity | null> {
  const result = await api.overleaf.getProjectDetails(projectId);
  if (!result?.success || !result.details) return null;
  const rootFolder = (result.details.rootFolder as OverleafFolderEntity[] | undefined)?.[0];
  if (!rootFolder) return null;

  const parts = entityRelPath.split('/').filter(Boolean);
  if (parts.length === 0) {
    const id = getEntityId(rootFolder);
    return id ? { id, type: 'folder' } : null;
  }

  const targetName = parts[parts.length - 1];
  const folderParts = parts.slice(0, -1);

  let current: OverleafFolderEntity = rootFolder;
  for (const part of folderParts) {
    const sub = (current.folders ?? []).find((folder) => folder.name === part);
    if (!sub) return null;
    current = sub;
  }

  if (!entityType || entityType === 'folder') {
    const folder = (current.folders ?? []).find((item) => item.name === targetName);
    if (folder) {
      const id = getEntityId(folder);
      if (id) return { id, type: 'folder' };
    }
    if (entityType === 'folder') return null;
  }
  if (!entityType || entityType === 'doc') {
    const doc = (current.docs ?? []).find((item) => item.name === targetName);
    if (doc) {
      const id = getEntityId(doc);
      if (id) return { id, type: 'doc' };
    }
  }
  if (!entityType || entityType === 'file') {
    const fileRef = (current.fileRefs ?? []).find((item) => item.name === targetName);
    if (fileRef) {
      const id = getEntityId(fileRef);
      if (id) return { id, type: 'file' };
    }
  }
  return null;
}

/** Backwards-compatible wrapper that returns the ID only. */
export async function resolveOverleafEntityId(
  projectId: string,
  entityRelPath: string,
  entityType?: 'doc' | 'file' | 'folder'
): Promise<string | null> {
  const resolved = await resolveOverleafEntity(projectId, entityRelPath, entityType);
  return resolved?.id ?? null;
}

type OverleafEntityOpArgs =
  | { op: 'rename'; params: OverleafLiveRenameEntityParams }
  | { op: 'delete'; params: OverleafLiveDeleteEntityParams }
  | { op: 'move'; params: OverleafLiveMoveEntityParams }
  | { op: 'create'; params: OverleafLiveCreateEntityParams };

export interface OverleafEntitySyncResult {
  success: boolean;
  skipped?: boolean;
  entityId?: string;
  entityType?: 'doc' | 'file' | 'folder';
  error?: string;
}

/** Asynchronously push a file operation to Overleaf and return the result so callers can decide whether to update the local map. */
export async function syncOverleafEntityOp(
  op: OverleafEntityOpArgs['op'],
  params: OverleafEntityOpArgs['params'],
  addLog?: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void
): Promise<OverleafEntitySyncResult> {
  try {
    let result: { success: boolean; error?: string; entityId?: string };
    const p = params as OverleafEntityOpArgs['params'];
    switch (op) {
      case 'rename':
        result = await overleafLive.renameEntity(p as OverleafLiveRenameEntityParams);
        break;
      case 'delete':
        result = await overleafLive.deleteEntity(p as OverleafLiveDeleteEntityParams);
        break;
      case 'move':
        result = await overleafLive.moveEntity(p as OverleafLiveMoveEntityParams);
        break;
      case 'create':
        result = await overleafLive.createEntity(p as OverleafLiveCreateEntityParams);
        break;
    }
    if (!result.success) {
      addLog?.('warning', `Overleaf sync failed (${op}): ${result.error || 'Unknown error'}`);
    }
    return {
      success: result.success,
      entityId: result.entityId,
      error: result.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog?.('warning', `Overleaf sync threw (${op}): ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Remove the entry from the Overleaf docIdMap after a delete and push the deletion to Overleaf.
 * Shared between command-driven and context-menu-driven delete flows to keep them consistent.
 */
export async function cleanupOverleafDocMapOnDelete(
  node: { path: string; type: string },
  addLog: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void
): Promise<OverleafEntitySyncResult> {
  const collab = getProjectRuntimeContext().state;
  if (!collab.overleafProjectId || !collab.rootPath) {
    return { success: true, skipped: true };
  }

  const rootNorm = collab.rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  const delRelPath = node.path.replace(/\\/g, '/').slice(rootNorm.length + 1);
  const delPrefix = `${delRelPath}/`;

  const isFolder = node.type === 'directory';
  const entityIdForSync = isFolder ? null : collab.overleafDocMap[delRelPath];

  if (collab.overleafProjectId) {
    let entityId = entityIdForSync;
    let entityType: 'doc' | 'file' | 'folder' = isFolder ? 'folder' : 'doc';
    if (!entityId) {
      // Missing from docMap → likely a fileRef (binary); auto-detect the real type via the project tree.
      const resolved = await resolveOverleafEntity(
        collab.overleafProjectId,
        delRelPath,
        isFolder ? 'folder' : undefined
      );
      if (resolved) {
        entityId = resolved.id;
        entityType = resolved.type;
      }
    }
    if (entityId) {
      const result = await syncOverleafEntityOp(
        'delete',
        {
          projectId: collab.overleafProjectId,
          entityType,
          entityId,
        },
        addLog
      );
      if (!result.success) {
        return { ...result, entityId, entityType };
      }
      const updatedMap = { ...collab.overleafDocMap };
      let changed = false;
      for (const key of Object.keys(updatedMap)) {
        if (key === delRelPath || key.startsWith(delPrefix)) {
          delete updatedMap[key];
          changed = true;
        }
      }
      if (changed) {
        getProjectRuntimeContext().update({ overleafDocMap: updatedMap });
        await persistOverleafDocMap(collab.rootPath, updatedMap, addLog);
      }
      return { success: true, entityId, entityType };
    }
  }
  return { success: true, skipped: true };
}

/**
 * Update the Overleaf docIdMap after a move/cut-paste and push the move to Overleaf.
 * Shared between command-driven and context-menu-driven paste flows to keep them consistent.
 */
export async function updateOverleafDocMapOnMove(
  oldPath: string,
  newPath: string,
  nodeType: string,
  addLog: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void
): Promise<OverleafEntitySyncResult> {
  const collab = getProjectRuntimeContext().state;
  if (!collab.overleafProjectId || !collab.rootPath) {
    return { success: true, skipped: true };
  }

  const rootNorm = collab.rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  const oldRelPath = oldPath.replace(/\\/g, '/').slice(rootNorm.length + 1);
  const newRelPath = newPath.replace(/\\/g, '/').slice(rootNorm.length + 1);
  // Capture entityId before mutating the map to avoid relying on a stale snapshot's timing.
  const isFolder = nodeType === 'directory';
  const entityIdForSync = isFolder ? null : collab.overleafDocMap[oldRelPath];

  if (collab.overleafProjectId) {
    let entityId = entityIdForSync;
    let entityType: 'doc' | 'file' | 'folder' = isFolder ? 'folder' : 'doc';
    if (!entityId) {
      const resolved = await resolveOverleafEntity(
        collab.overleafProjectId,
        oldRelPath,
        isFolder ? 'folder' : undefined
      );
      if (resolved) {
        entityId = resolved.id;
        entityType = resolved.type;
      }
    }
    const targetRelPath = toRelativePath(
      newPath.replace(/\\/g, '/').replace(/\/[^/]+$/, ''),
      rootNorm
    );
    const targetFolderId = await resolveOverleafFolderId(collab.overleafProjectId, targetRelPath);
    if (!entityId) {
      return { success: false, error: `Cannot resolve Overleaf entity for move: ${oldRelPath}` };
    }
    if (!targetFolderId) {
      return {
        success: false,
        error: `Cannot resolve Overleaf target folder: ${targetRelPath || '(root)'}`,
      };
    }
    const result = await syncOverleafEntityOp(
      'move',
      {
        projectId: collab.overleafProjectId,
        entityType,
        entityId,
        targetFolderId,
      },
      addLog
    );
    if (!result.success) {
      return { ...result, entityId, entityType };
    }

    const updatedMap = { ...collab.overleafDocMap };
    const oldPrefix = `${oldRelPath}/`;
    const newPrefix = `${newRelPath}/`;
    let changed = false;
    for (const key of Object.keys(updatedMap)) {
      if (key === oldRelPath) {
        updatedMap[newRelPath] = updatedMap[key];
        delete updatedMap[key];
        changed = true;
      } else if (key.startsWith(oldPrefix)) {
        updatedMap[newPrefix + key.slice(oldPrefix.length)] = updatedMap[key];
        delete updatedMap[key];
        changed = true;
      }
    }
    if (changed) {
      getProjectRuntimeContext().update({ overleafDocMap: updatedMap });
      await persistOverleafDocMap(collab.rootPath, updatedMap, addLog);
    }
    return { success: true, entityId, entityType };
  }
  return { success: true, skipped: true };
}
